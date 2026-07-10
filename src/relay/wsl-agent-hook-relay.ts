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

import { RELAY_SENTINEL } from './protocol'
import { RelayDispatcher } from './dispatcher'
import { RelayAgentHookServer } from './agent-hook-server'
import { registerWslHookFsHandlers } from './wsl-hook-fs-bridge'
import {
  AGENT_HOOK_NOTIFICATION_METHOD,
  AGENT_HOOK_REQUEST_REPLAY_METHOD
} from '../shared/agent-hook-relay'
import {
  sanitizeWslHookInstanceKey,
  WSL_HOOK_RELAY_INSTANCE_ENV,
  wslHookRelayEndpointDir
} from '../shared/wsl-hook-relay-contract'

async function main(): Promise<void> {
  const windowsPort = Number(process.env.ORCA_AGENT_HOOK_PORT ?? '')
  const token = process.env.ORCA_AGENT_HOOK_TOKEN ?? ''
  if (!Number.isInteger(windowsPort) || windowsPort <= 0 || token.length === 0) {
    process.stderr.write('[wsl-hook-relay] missing ORCA_AGENT_HOOK_PORT/TOKEN in env\n')
    process.exit(1)
  }

  let stdoutAlive = true
  const dispatcher = new RelayDispatcher((data) => {
    if (!stdoutAlive) {
      return
    }
    return process.stdout.write(data)
  })

  // Why: restart-stable instance key keeps the endpoint file at one path
  // across app restarts so surviving agents re-coordinate off its rewrite.
  const instanceKey =
    sanitizeWslHookInstanceKey(process.env[WSL_HOOK_RELAY_INSTANCE_ENV]) ?? `port${windowsPort}`
  const hookServer = new RelayAgentHookServer({
    endpointDir: wslHookRelayEndpointDir(homedir(), instanceKey),
    token,
    preferredPort: windowsPort,
    forward: (envelope) =>
      dispatcher.notify(
        AGENT_HOOK_NOTIFICATION_METHOD,
        envelope as unknown as Record<string, unknown>
      )
  })

  dispatcher.onRequest(AGENT_HOOK_REQUEST_REPLAY_METHOD, async () => ({
    replayed: hookServer.replayCachedPayloadsForPanes()
  }))
  registerWslHookFsHandlers(dispatcher, homedir(), () => ({
    portFallback: hookServer.usedPortFallback,
    boundPort: hookServer.getCoordinates().port
  }))

  try {
    await hookServer.start()
  } catch (err) {
    process.stderr.write(
      `[wsl-hook-relay] hook server bind failed: ${err instanceof Error ? err.message : String(err)}\n`
    )
    process.exit(1)
  }
  if (hookServer.usedPortFallback) {
    // Why: diagnosable breadcrumb — hook clients are fail-open silent, the
    // relay must not be. Fallback is expected under mirrored networking.
    process.stderr.write(
      `[wsl-hook-relay] port ${windowsPort} occupied; bound ${hookServer.getCoordinates().port} (endpoint-file re-coordination)\n`
    )
  }

  const shutdown = (): void => {
    stdoutAlive = false
    dispatcher.dispose()
    hookServer.stop()
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
    process.stderr.write(`[wsl-hook-relay] uncaught exception: ${err.message}\n`)
    process.exit(1)
  })
  process.on('unhandledRejection', (reason) => {
    process.stderr.write(`[wsl-hook-relay] unhandled rejection: ${String(reason)}\n`)
  })

  // Signal readiness — the host watches for this exact string before
  // sending framed data (same contract as the SSH relay).
  process.stdout.write(RELAY_SENTINEL)
}

void main()
