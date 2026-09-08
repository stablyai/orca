#!/usr/bin/env node
// Guest-resident WSL agent-hook relay (STA-1515). Runs inside a WSL distro,
// binds a loopback hook receiver on the very port the Windows host issued
// (free under NAT — that port only exists Windows-side), and forwards every
// parsed hook envelope to Orca over this process's own stdin/stdout using the
// framed JSON-RPC protocol the SSH relay already speaks. Also hosts the
// home-scoped fs bridge the host uses to install hook configs into the guest.
//
// Lifecycle: dies when stdin closes. A lingering guest listener would let
// WSL's Windows→WSL forwarder grab the freed Windows-side port and blackhole
// stale Windows-side hook posts — so unlike the SSH relay there is no grace
// period and no daemon socket.
import { homedir } from 'node:os'

import { RELAY_SENTINEL, RELAY_VERSION } from './protocol'
import { RelayDispatcher } from './dispatcher'
import { RelayAgentHookServer } from './agent-hook-server'
import { registerWslHookFsHandlers } from './wsl-hook-fs-bridge'
import { PluginOverlayManager } from './plugin-overlay'
import { createInstallPluginsHandler } from './wsl-install-plugins-handler'
import { PreflightHandler } from './preflight-handler'
import { registerWslRelayProcessHandlers } from './wsl-relay-process'
import {
  AGENT_HOOK_INSTALL_PLUGINS_METHOD,
  AGENT_HOOK_REQUEST_REPLAY_METHOD
} from '../shared/agent-hook-relay'
import { publishAgentHookEnvelope } from './agent-hook-envelope-publication'
import {
  sanitizeWslHookInstanceKey,
  WSL_RELAY_CAPABILITIES,
  WSL_RELAY_HOOKS_SET_ENABLED_METHOD,
  WSL_HOOK_RELAY_INSTANCE_ENV,
  wslHookRelayEndpointDir
} from '../shared/wsl-hook-relay-contract'

async function main(): Promise<void> {
  const windowsPort = Number(process.env.ORCA_AGENT_HOOK_PORT ?? '')
  const token = process.env.ORCA_AGENT_HOOK_TOKEN ?? ''
  const hooksEnabled = process.env.ORCA_WSL_RELAY_HOOKS_ENABLED !== '0'
  const relayDistro = process.env.ORCA_WSL_RELAY_DISTRO?.trim() || null
  if (hooksEnabled && (!Number.isInteger(windowsPort) || windowsPort <= 0 || token.length === 0)) {
    process.stderr.write('[wsl-relay] hook capability disabled: missing port/token\n')
  }

  let stdoutAlive = true
  let hookCapabilityEnabled = hooksEnabled
  const dispatcher = new RelayDispatcher(
    (data, onSettled) => {
      if (!stdoutAlive) {
        onSettled({ ok: false, error: new Error('WSL relay stdout is closed') })
        return false
      }
      return process.stdout.write(data, (error) => {
        onSettled(error ? { ok: false, error } : { ok: true })
      })
    },
    {
      supportsWriteCallback: true,
      writableLength: () => process.stdout.writableLength,
      writableHighWaterMark: () => process.stdout.writableHighWaterMark,
      waitWriteDrain: (callback) => {
        process.stdout.once('drain', callback)
        return () => process.stdout.off('drain', callback)
      }
    }
  )

  // Why: restart-stable instance key keeps the endpoint file at one path
  // across app restarts so surviving agents re-coordinate off its rewrite.
  const instanceKey =
    sanitizeWslHookInstanceKey(process.env[WSL_HOOK_RELAY_INSTANCE_ENV]) ?? `port${windowsPort}`
  const hookServer =
    Number.isInteger(windowsPort) && windowsPort > 0 && token.length > 0
      ? new RelayAgentHookServer({
          endpointDir: wslHookRelayEndpointDir(homedir(), instanceKey),
          token,
          preferredPort: windowsPort,
          forward: (envelope) => {
            if (hookCapabilityEnabled) {
              publishAgentHookEnvelope(dispatcher, envelope)
            }
          }
        })
      : null
  new PreflightHandler(dispatcher)
  registerWslRelayProcessHandlers(dispatcher, relayDistro)
  dispatcher.onRequest('relay.capabilities', async () => ({
    protocolMajor: 1,
    protocolMinor: 0,
    bundleVersion: RELAY_VERSION,
    capabilities: Object.values(WSL_RELAY_CAPABILITIES)
  }))
  dispatcher.onRequest(WSL_RELAY_HOOKS_SET_ENABLED_METHOD, async (params) => {
    const enabled = params.enabled === true
    if (enabled === hookCapabilityEnabled) {
      return { enabled: hookCapabilityEnabled }
    }
    hookCapabilityEnabled = enabled
    if (!hookServer) {
      hookCapabilityEnabled = false
      return { enabled: false }
    }
    return { enabled: hookCapabilityEnabled }
  })

  if (hookServer) {
    dispatcher.onRequest(AGENT_HOOK_REQUEST_REPLAY_METHOD, async () => ({
      replayed: hookCapabilityEnabled ? hookServer.replayCachedPayloadsForPanes() : 0
    }))
  }

  // Why: OpenCode reports status via a plugin (not a hooks.json script), so the
  // host ships its source over the wire and the guest materializes a config
  // overlay here — the same PluginOverlayManager path the SSH relay uses. One
  // handler for the relay's life: it remembers the materialized overlay so
  // repeat installs don't rebuild it under running agents.
  if (hookServer) {
    const installPlugins = createInstallPluginsHandler(new PluginOverlayManager(), process.env)
    dispatcher.onRequest(AGENT_HOOK_INSTALL_PLUGINS_METHOD, async (params) =>
      hookCapabilityEnabled ? installPlugins(params) : { overlayDirs: {} }
    )
  }

  registerWslHookFsHandlers(
    dispatcher,
    homedir(),
    hookServer
      ? () => ({
          portFallback: hookServer.usedPortFallback,
          boundPort: hookServer.getCoordinates().port
        })
      : undefined
  )

  try {
    await hookServer?.start()
  } catch (err) {
    process.stderr.write(
      `[wsl-relay] hook server bind failed: ${err instanceof Error ? err.message : String(err)}\n`
    )
    process.exit(1)
  }
  if (hookServer?.usedPortFallback) {
    // Why: diagnosable breadcrumb — hook clients are fail-open silent, the
    // relay must not be. Fallback is expected under mirrored networking.
    process.stderr.write(
      `[wsl-relay] port ${windowsPort} occupied; bound ${hookServer.getCoordinates().port} (endpoint-file re-coordination)\n`
    )
  }

  const shutdown = (): void => {
    stdoutAlive = false
    dispatcher.dispose()
    hookServer?.stop()
    process.exit(0)
  }

  process.stdin.on('data', (chunk: Buffer) => dispatcher.feed(chunk))
  process.stdin.on('end', shutdown)
  process.stdin.on('error', shutdown)
  process.stdout.on('error', shutdown)
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
  // Why: same posture as the SSH relay — an uncaught exception may leave
  // broken invariants, so exit and let the host manager respawn a clean
  // relay; a stray rejection is logged and survived (hook delivery must not
  // die for a non-fatal async error).
  process.on('uncaughtException', (err) => {
    process.stderr.write(`[wsl-relay] uncaught exception: ${err.message}\n`)
    process.exit(1)
  })
  process.on('unhandledRejection', (reason) => {
    process.stderr.write(`[wsl-relay] unhandled rejection: ${String(reason)}\n`)
  })

  // Signal readiness — the host watches for this exact string before
  // sending framed data (same contract as the SSH relay).
  dispatcher.writePrimaryBytes(Buffer.from(RELAY_SENTINEL))
}

void main()
