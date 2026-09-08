/**
 * agent-pty-registry.ts — in-process PTY registry, connection rebinding, and
 * grace-period/cleanup logic for agent-spawner.ts (CR-AG-12 / CR-STORAGE-008b).
 *
 * Split out of agent-spawner.ts (oxlint max-lines) — see that file's header
 * for the full picture of how these pieces fit together.
 *
 * @module relay/agent-pty-registry
 */
import type * as nodePtyTypes from 'node-pty'
import type WebSocket from 'ws'
import { encodeDataFrame } from 'orca-dev-agent-transport'
import type { WireState } from 'orca-dev-agent-transport'
import type { AgentLogger } from './agent-logger'

// ── PTY Registry (in-process singleton) ──────────────────────────────────────

// PTY registry — keyed by ptyId, value holds the IPty instance (type-erased to any
// to avoid pulling in the static node-pty types at module load time).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const PTY_REGISTRY = new Map<
  string,
  {
    pty: nodePtyTypes.IPty
    taskId: string
    userId: string
    /** Set while a grace period is running (WS disconnected, not yet reconnected
     *  or expired) — see scheduleAgentSpawnGracePeriod(). Cleared on rebind. */
    graceTimer?: ReturnType<typeof setTimeout> | null
  }
>()

// ── Connection rebinding (CR-STORAGE-008b) ────────────────────────────────────
// Why this exists: before this change, cleanupAllPtys() was called
// unconditionally on every WS disconnect (see the doc comment on that
// function below) — a 1s network blip killed every running AI-agent CLI
// session. The fix mirrors pty-agent-bridge.ts's already-proven pattern for
// terminal PTYs (grace period + reattach), adapted for the fact that
// agent-spawner.ts's PTY_REGISTRY lives in the agent's own process (not a
// separate daemon like pty-agent-bridge.ts) and has no per-PTY "attach" RPC
// from the client — there is exactly one live WebSocket per agent process at
// a time, so "reattach" here means "rebind every tracked PTY to whichever
// connection is current," not a per-ptyId call.
let currentConnection: { ws: WebSocket; wireState: WireState } | null = null

/**
 * rebindAgentSpawnConnection — Called whenever the agent's WebSocket to Orca
 * (re)establishes (both the initial connection and every reconnect). Updates
 * where pending/future `agent.output`/`agent.exited` push notifications get
 * sent, and cancels any grace-period timers that were counting down —
 * a live connection means the work can keep being observed, so there is
 * nothing left to protect against.
 */
export function rebindAgentSpawnConnection(ws: WebSocket, wireState: WireState): void {
  currentConnection = { ws, wireState }
  for (const entry of PTY_REGISTRY.values()) {
    if (entry.graceTimer) {
      clearTimeout(entry.graceTimer)
      entry.graceTimer = null
    }
  }
}

/** Push an `agent.output`/`agent.exited`-shaped notification over whichever
 *  connection is current. Best-effort: if there is no live connection (WS
 *  disconnected, grace period still running), the notification is simply
 *  dropped — nothing is buffered/replayed today (unlike pty-agent-bridge.ts's
 *  scrollback buffer for terminals). This is a known gap, not a silent
 *  regression: it existed before this change too (the old code's closed-over
 *  `ws` would throw/no-op once the connection died), and closing it (a replay
 *  buffer for agent.spawn output) is future work, not required to satisfy
 *  CR-STORAGE-008(b)'s "the PTY keeps running and can be reattached to"
 *  requirement. */
export function sendAgentSpawnNotification(method: string, params: Record<string, unknown>): void {
  if (!currentConnection) {
    return
  }
  const { ws, wireState } = currentConnection
  if (ws.readyState !== 1 /* WebSocket.OPEN */) {
    return
  }
  try {
    ws.send(encodeDataFrame(wireState, JSON.stringify({ jsonrpc: '2.0', method, params })))
  } catch {
    /* best effort */
  }
}

/** How long an agent.spawn PTY survives after the agent's WS to Orca
 *  disconnects, waiting for a reconnect, before being killed for real.
 *  Deliberately the same value as pty-agent-bridge.ts's PTY_GRACE_PERIOD_MS
 *  (terminal PTYs) — both need to survive the same worst case (a full agent
 *  process restart: systemd RestartSec + node startup + token fetch/retry +
 *  WS reconnect), so there is no principled reason for the two windows to
 *  differ today. Kept as an independent constant (not imported from
 *  pty-agent-bridge.ts) because that module runs inside the separate
 *  pty-daemon process, not the main agent process this file runs in — see
 *  specs/agent/crs/v3/storage/tasks/TASK-AG-STORAGE-008-align-grace-period-with-backend-go.md
 *  for the cross-service constraint this value must also satisfy once
 *  backend-go's own grace_period_seconds (BE-SOL-STORAGE-003) exists. */
export const AGENT_SPAWN_PTY_GRACE_PERIOD_MS = 120_000

/**
 * scheduleAgentSpawnGracePeriod — Called when the agent's WebSocket to Orca
 * disconnects (agent-session.ts's stop()). Instead of killing every
 * agent.spawn PTY immediately (the old cleanupAllPtys() behavior), arms a
 * grace timer per PTY; rebindAgentSpawnConnection() (called on the next
 * successful reconnect) cancels it. If no reconnect arrives in time, the PTY
 * is killed for real — mirrors pty-agent-bridge.ts's
 * scheduleGracePeriodCleanup() exactly.
 */
export function scheduleAgentSpawnGracePeriod(
  log: AgentLogger,
  graceTimeMs = AGENT_SPAWN_PTY_GRACE_PERIOD_MS
): void {
  for (const [ptyId, entry] of PTY_REGISTRY.entries()) {
    if (entry.graceTimer) {
      continue
    } // already counting down from an earlier disconnect
    entry.graceTimer = setTimeout(() => {
      const current = PTY_REGISTRY.get(ptyId)
      if (!current || current.graceTimer !== entry.graceTimer) {
        return
      } // reconnected or already gone
      try {
        if (process.platform === 'win32') {
          current.pty.kill()
        } else {
          current.pty.kill('SIGTERM')
        }
        log.info(`scheduleAgentSpawnGracePeriod: grace period expired, killed ${ptyId}`)
      } catch {
        /* best effort */
      }
      PTY_REGISTRY.delete(ptyId)
    }, graceTimeMs)
  }
  if (PTY_REGISTRY.size > 0) {
    log.info(
      `scheduleAgentSpawnGracePeriod: armed grace timers for ${PTY_REGISTRY.size} PTY(s) (${graceTimeMs}ms)`
    )
  }
}

// ── cleanupAllPtys ───────────────────────────────────────────────────────────
// ORCH-011 (original): Kill all PTYs in registry when the WS session closes.
// Prevents orphaned agent processes consuming resources on the Dev Server.
//
// CR-STORAGE-008(b) (2026-09-07): agent-session.ts's stop() no longer calls
// this on an ordinary disconnect — see scheduleAgentSpawnGracePeriod() above,
// which replaced it there so a transient network blip doesn't kill in-flight
// AI-agent work. This function is kept for the ONE case that still needs an
// immediate, unconditional kill: a confirmed, explicit teardown (e.g. the
// user logs out and confirms closing all connections, CR-STORAGE-008 part a)
// — see TASK-AG-STORAGE-007's note that the exact inbound wire method for
// that signal is not yet defined (coordinate with backend-go/frontend before
// wiring a caller). Until that exists, this function has no caller in
// agent-session.ts — it remains exported/tested so that caller can be added
// without re-deriving the kill logic.

export function cleanupAllPtys(log: AgentLogger): void {
  if (PTY_REGISTRY.size === 0) {
    return
  }
  log.info(`session.stop: cleaning up ${PTY_REGISTRY.size} orphaned PTY(s)`)
  for (const [ptyId, entry] of PTY_REGISTRY.entries()) {
    try {
      if (process.platform === 'win32') {
        entry.pty.kill()
      } else {
        entry.pty.kill('SIGTERM')
      }
      log.info(`session.stop: killed PTY ${ptyId}`)
    } catch (err) {
      log.warn(`session.stop: failed to kill PTY ${ptyId}: ${err}`)
    }
  }
  PTY_REGISTRY.clear()
}
