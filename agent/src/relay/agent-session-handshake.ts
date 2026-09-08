// src/relay/agent-session-handshake.ts
// Handshake-frame send, keepalive-timer, and liveness-monitor setup for a
// single agent WS session — split out of agent-session.ts to keep that file
// under oxlint's max-lines budget. Each function here is invoked once per
// connection from agent-session.ts's start(); state (timer/liveness handles)
// stays owned by the caller, these just build/start them.

import type WebSocket from 'ws'
import type { AgentConfig } from './agent-config'
import type { ToolDefinition } from './agent-tool-registry'
import type { AgentLogger } from './agent-logger'
import { encodeDataFrame, encodeKeepaliveFrame } from 'orca-dev-agent-transport'
import type { createWireState } from 'orca-dev-agent-transport'
import type { TraceSpan } from '../shared/trace'
import {
  AGENT_HANDSHAKE_METHOD,
  AGENT_KEEPALIVE_INTERVAL_MS,
  AGENT_TIMEOUT_MS
} from '../shared/agent-wire-protocol'
import { startRemoteRuntimeSocketLiveness } from '../shared/remote-runtime-socket-liveness'
import { buildCapabilities, STATIC_CAPABILITIES_FALLBACK } from './agent-session-capabilities'

export async function sendHandshake(
  ws: WebSocket,
  wireState: ReturnType<typeof createWireState>,
  config: AgentConfig,
  tools: ToolDefinition[],
  log: AgentLogger,
  /** Optional: pre-built capabilities (used in tests to bypass async git/pty checks) */
  prebuiltCapabilities?: readonly string[],
  /** Optional: token override for renewed tokens (supersedes config.agentToken) */
  tokenOverride?: string
): Promise<void> {
  // WT-Issue-2: Use dynamic capabilities with 5s timeout fallback
  // If prebuiltCapabilities is provided (e.g. in tests), skip the async check entirely.
  let capabilities: readonly string[]
  if (prebuiltCapabilities) {
    capabilities = prebuiltCapabilities
  } else {
    try {
      capabilities = await Promise.race([
        buildCapabilities(config, log),
        new Promise<readonly string[]>((_res, reject) =>
          setTimeout(() => reject(new Error('capability check timeout')), 5000)
        )
      ])
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.warn(`buildCapabilities failed (${msg}) — using static fallback`)
      capabilities = STATIC_CAPABILITIES_FALLBACK
    }
  }

  const rpc = {
    jsonrpc: '2.0' as const,
    id: 1,
    method: AGENT_HANDSHAKE_METHOD,
    params: {
      agentVersion: '5.0.0',
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      capabilities,
      // agentToken is only sent in direct-websocket mode; empty string = omit.
      // tokenOverride takes precedence so renewed tokens are used transparently.
      ...(tokenOverride || config.agentToken
        ? { agentToken: tokenOverride ?? config.agentToken }
        : {}),
      devServerId: config.devServerId,
      tools: tools.map((t) => t.name)
    }
  }
  ws.send(encodeDataFrame(wireState, JSON.stringify(rpc)))
  log.info(
    `Handshake sent: devServerId=${config.devServerId} tools=[${tools.map((t) => t.name).join(',')}]`
  )
}

export function startKeepalive(
  ws: WebSocket,
  wireState: ReturnType<typeof createWireState>
): ReturnType<typeof setInterval> {
  return setInterval(() => {
    if (ws.readyState === 1 /* WebSocket.OPEN */) {
      ws.send(encodeKeepaliveFrame(wireState))
    }
  }, AGENT_KEEPALIVE_INTERVAL_MS)
}

export function startLiveness(
  ws: WebSocket,
  span: TraceSpan,
  log: AgentLogger
): ReturnType<typeof startRemoteRuntimeSocketLiveness> {
  return startRemoteRuntimeSocketLiveness({
    ping: () => {
      if (ws.readyState === 1 /* WebSocket.OPEN */) {
        try {
          ws.ping()
        } catch {
          // socket already mid-teardown — the 'close' handler settles it
        }
      }
    },
    onDead: () => {
      // Mirrors the old watchdog's own guard: only act while the socket
      // still believes it's open — an already-closed/closing ws (e.g. the
      // peer sent a clean close moments before the liveness window
      // elapsed) needs no further action here.
      if (ws.readyState !== 1 /* WebSocket.OPEN */) {
        return
      }
      log.warn(`Idle timeout: no frame/ping/pong received — terminating connection`)
      span.fail('idle timeout (liveness monitor)')
      // NOT ws.close() — see agent-session.ts's `liveness` field doc comment
      // for why a real half-open socket needs terminate(), not close().
      ws.terminate()
    },
    options: { pingIntervalMs: AGENT_KEEPALIVE_INTERVAL_MS, livenessTimeoutMs: AGENT_TIMEOUT_MS }
  })
}
