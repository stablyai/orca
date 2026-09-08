// src/relay/agent-session.ts
// Manages a single WebSocket connection session for the Orca Dev Agent.
//
// Responsibilities:
//   1. Send handshake frame immediately on connect
//   2. Send keepalive frames on AGENT_KEEPALIVE_INTERVAL_MS cadence
//   3. Respond to incoming KeepAlive frames with a keepalive pong
//   4. Gate RPC dispatch behind successful handshake
//   5. Close ws with code 1008 on handshake auth failure
//
// Design:
//   - createSession() returns an AgentSession factory — one per WS connection
//   - WireState is created inside start() — NOT at module level
//   - stop() must be called when ws closes to clear the keepalive interval
//
// Split for oxlint's max-lines budget: capability detection lives in
// agent-session-capabilities.ts, and handshake-send/keepalive/liveness setup
// live in agent-session-handshake.ts. This file keeps the per-connection
// state (timers, handshake flag) and the frame/message router.

import type WebSocket from 'ws'
import type { AgentConfig } from './agent-config'
import type { ToolDefinition } from './agent-tool-registry'
import type { AgentLogger } from './agent-logger'
import {
  createWireState,
  decodeFrame,
  encodeKeepaliveFrame,
  parseJsonPayload,
  MessageType
} from 'orca-dev-agent-transport'
import { createRpcDispatcher } from './agent-rpc-dispatch'
import type { JsonRpcRequest } from './agent-rpc-dispatch'
import { createTracer } from '../shared/trace'
import { scheduleAgentSpawnGracePeriod, rebindAgentSpawnConnection } from './agent-spawner'
import { notifyDaemonSessionClosed } from './pty-daemon-client'
import { cleanupAgentWatches } from './fs-agent-extensions'
import { sendHandshake, startKeepalive, startLiveness } from './agent-session-handshake'

const sessionTracer = createTracer('agent:session')

export type AgentSession = {
  /** Attach session logic to an already-constructed WebSocket (may or may not be open yet). */
  start(ws: WebSocket): void
  /** Clear keepalive interval. Call from ws 'close' handler. */
  stop(): void
  /** Register a callback that fires once after a successful handshake. */
  onHandshakeOk(callback: () => void): void
}

export function createSession(
  config: AgentConfig,
  tools: ToolDefinition[],
  log: AgentLogger,
  /** Optional: pre-built capabilities (used in tests to bypass async git/pty checks) */
  _prebuiltCapabilities?: readonly string[],
  /** Optional: token override for renewed tokens (supersedes config.agentToken) */
  tokenOverride?: string
): AgentSession {
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null
  // Why: AGENT_TIMEOUT_MS ("if no frame received in 20000ms → close
  // connection") was declared as a wire-protocol constant but never actually
  // enforced anywhere — see specs/agent/api/gaps-and-findings.md #8. The
  // first fix (a bespoke lastFrameReceivedAt timer calling ws.close()) still
  // failed to recover a genuinely half-open socket live in production for
  // hours: close() performs the real WS closing handshake, which needs the
  // peer to respond — a peer that's actually gone (no RST received) leaves
  // that handshake hanging for the OS's TCP retransmission timeout. Reuse
  // the shared liveness monitor that already solves this correctly
  // (agent/src/shared/remote-runtime-client.ts's own connection, same
  // failure mode) — it calls ws.terminate() instead, which tears the socket
  // down locally without waiting on the peer.
  let liveness: ReturnType<typeof startLiveness> | null = null
  let handshakeDone = false
  const handshakeOkCallbacks: (() => void)[] = []
  const dispatcher = createRpcDispatcher(tools, config, log)

  return {
    start(ws: WebSocket): void {
      // wireState is scoped to this connection — not shared
      const wireState = createWireState()
      const span = sessionTracer.start({ devServerId: config.devServerId })

      // sendHandshake is async (builds dynamic capabilities) — wrap in a local helper
      const doHandshake = (): void => {
        void sendHandshake(ws, wireState, config, tools, log, _prebuiltCapabilities, tokenOverride)
          .then(() => {
            span.step('handshake-sent')
            keepaliveTimer = startKeepalive(ws, wireState)
            liveness = startLiveness(ws, span, log)
          })
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err)
            log.error(`sendHandshake failed: ${msg}`)
            span.fail(err, { phase: 'handshake' })
            ws.close(1011, 'Handshake error')
          })
      }

      if (ws.readyState === 1 /* WebSocket.OPEN */) {
        doHandshake()
      } else {
        ws.once('open', () => {
          log.info('WebSocket opened')
          doHandshake()
        })
      }

      ws.on('message', (data: Buffer | string) => {
        // Agent protocol uses binary frames only
        if (!Buffer.isBuffer(data)) {
          return
        }

        const frame = decodeFrame(wireState, data)
        if (!frame) {
          log.warn('Received malformed frame (too short) — ignoring')
          return
        }
        // Any successfully-decoded frame (data or keepalive) counts as
        // liveness for the connection-health monitor — see startLiveness().
        liveness?.noteActivity()
        // TEMP DIAG BUG-FE-PTY-001
        log.info(
          `[DIAG BUG-FE-PTY-001] recv frame type=${frame.type} seq=${frame.seq} ack=${frame.ack} len=${frame.length} readyState=${ws.readyState} t=${Date.now()}`
        )

        // Respond to KeepAlive frames immediately to maintain ACK progress
        if (frame.type === MessageType.KeepAlive) {
          if (ws.readyState === 1) {
            ws.send(encodeKeepaliveFrame(wireState))
          }
          return
        }

        // Empty data frame — ignore
        if (frame.payload.length === 0) {
          return
        }

        const rpc = parseJsonPayload<{
          id: string | number | null
          result?: { ok?: boolean; orcaVersion?: string; sessionId?: string }
          error?: { code: number; message: string }
          method?: string
          params?: Record<string, unknown>
        }>(frame.payload)

        if (!rpc) {
          log.warn('Received non-JSON frame payload — ignoring')
          return
        }

        if (!handshakeDone) {
          // Only process handshake result (id=1) before handshake completes
          if (rpc.result?.ok === true) {
            handshakeDone = true
            const sessionId = rpc.result.sessionId ?? 'unknown'
            const orcaVersion = rpc.result.orcaVersion ?? 'unknown'
            log.info(`Handshake OK: sessionId=${sessionId} orcaVersion=${orcaVersion}`)
            span.step('handshake-ok', { sessionId, orcaVersion })
            // CR-STORAGE-008(b): rebind every still-running agent.spawn PTY
            // (from before this reconnect) to the new connection and cancel
            // any grace-period timers left counting down from the drop that
            // preceded it — see agent-spawner.ts's rebindAgentSpawnConnection.
            rebindAgentSpawnConnection(ws, wireState)
            handshakeOkCallbacks.forEach((cb) => cb())
          } else if (rpc.error) {
            log.error(`Handshake failed: code=${rpc.error.code} message=${rpc.error.message}`)
            span.fail(`handshake: ${rpc.error.message}`, { code: rpc.error.code })
            ws.close(1008, 'Handshake failed')
          }
          return
        }

        // Post-handshake: dispatch JSON-RPC request
        if (typeof rpc.method === 'string') {
          // TEMP DIAG BUG-FE-PTY-001: dispatch() is fire-and-forget (void) —
          // if it ever rejects, that's an unhandled rejection with no other
          // visibility. Wrap it here so a throw is at least logged with which
          // request triggered it, in addition to the process-level handler
          // in agent-entry.ts.
          log.info(
            `[DIAG BUG-FE-PTY-001] dispatch start id=${rpc.id} method=${rpc.method} t=${Date.now()}`
          )
          dispatcher
            .dispatch(ws, wireState, rpc as JsonRpcRequest)
            .then(() => {
              log.info(
                `[DIAG BUG-FE-PTY-001] dispatch done id=${rpc.id} method=${rpc.method} readyState=${ws.readyState} t=${Date.now()}`
              )
            })
            .catch((err: unknown) => {
              log.error(
                `[DIAG BUG-FE-PTY-001] dispatch THREW id=${rpc.id} method=${rpc.method}: ${err instanceof Error ? err.stack : String(err)}`
              )
            })
        }
      })

      // Why a pong handler when nothing ever explicitly waits on one: the
      // liveness monitor's own contract counts pings/pongs as activity too
      // (not just data frames) — startLiveness()'s ping() call above emits
      // an RFC 6455 control-frame ping every tick, and the peer answers it
      // automatically at the protocol layer even if the app-level KeepAlive
      // frame stream ever stalled for some other reason.
      ws.on('pong', () => liveness?.noteActivity())

      ws.on('close', (code: number, reason: Buffer) => {
        this.stop()
        const reasonStr = reason.toString()
        if (code === 1000) {
          span.ok({ code, reason: reasonStr })
        } else {
          span.fail(`ws close code=${code}`, { code, reason: reasonStr })
        }
        log.info(`Session closed code=${code} reason=${reasonStr}`)
      })

      ws.on('error', (err: Error) => {
        span.fail(err, { phase: 'ws-error' })
        log.error(`WebSocket error: ${err.message}`)
      })
    },

    stop(): void {
      if (keepaliveTimer !== null) {
        clearInterval(keepaliveTimer)
        keepaliveTimer = null
      }
      if (liveness !== null) {
        liveness.stop()
        liveness = null
      }
      // CR-STORAGE-008(b) (2026-09-07): agent-spawned (agent.spawn) PTYs used
      // to be killed immediately here (ORCH-011) — a separate PTY population
      // from pty.create terminals, in the agent's own process rather than the
      // detached pty-daemon. That meant a 1s network blip killed every
      // running AI-agent CLI session. Now mirrors pty.create terminals' own
      // grace-period behavior instead: arm a timer per PTY, cancelled by
      // rebindAgentSpawnConnection() on the next successful reconnect (see
      // the handshake-ok branch above). See
      // specs/agent/crs/v3/storage/solutions/SOL-AG-STORAGE-003-agent-spawn-pty-daemon-grace-period.md.
      scheduleAgentSpawnGracePeriod(log)
      // Terminal (pty.create) PTYs live in the detached pty-daemon process
      // (pty-daemon-client.ts) — tell it this WS session ended so it can arm
      // grace-period timers itself (see pty-agent-bridge.ts). Best-effort and
      // fire-and-forget: stop() must not block on it, and a daemon that's
      // unreachable has no PTYs left to protect anyway. fs.watch watchers
      // have no reattach concept and are cheap to re-establish, so those
      // still clean up immediately.
      void notifyDaemonSessionClosed(log)
      cleanupAgentWatches()
    },

    onHandshakeOk(callback: () => void): void {
      handshakeOkCallbacks.push(callback)
    }
  }
}
