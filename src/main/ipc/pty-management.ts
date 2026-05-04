import { ipcMain } from 'electron'
import { DaemonPtyRouter } from '../daemon/daemon-pty-router'
import type { DaemonPtyAdapter } from '../daemon/daemon-pty-adapter'
import { getDaemonProvider, restartDaemon } from '../daemon/daemon-init'
import type { DaemonSessionInfo } from '../daemon/types'

// Why: the daemon's session.kill() sends SIGTERM first and escalates to
// SIGKILL after a 5s grace window (KILL_TIMEOUT_MS in session.ts). We have
// to poll past that ladder, or well-behaved-but-slow shells (zsh hosting a
// long-running agent) look like they "refused to exit" when they're actually
// still inside their SIGTERM handler waiting for SIGKILL. 65 polls at 100ms
// each (≈6.5s) covers the 5s ladder plus ~1.5s of slack for the final
// SIGKILL reap and the adapter's listSessions IPC roundtrip. The user waits
// during this window with a spinner; the alternative — reporting fake
// "refused" numbers — is worse.
const MAX_POLL_ATTEMPTS = 65
const POLL_INTERVAL_MS = 100

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function getDaemonAdapters(): DaemonPtyAdapter[] {
  const provider = getDaemonProvider()
  if (!provider) {
    return []
  }
  if (provider instanceof DaemonPtyRouter) {
    return [...provider.getAllAdapters()]
  }
  return [provider]
}

async function collectSessions(adapters: DaemonPtyAdapter[]): Promise<DaemonSessionInfo[]> {
  const results = await Promise.allSettled(
    adapters.map(async (adapter) => {
      const sessions = await adapter.listSessions()
      return sessions.map<DaemonSessionInfo>((s) => ({
        ...s,
        protocolVersion: adapter.protocolVersion
      }))
    })
  )
  return results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
}

export function registerDaemonManagementHandlers(): void {
  ipcMain.removeHandler('pty:management:listSessions')
  ipcMain.removeHandler('pty:management:killAll')
  ipcMain.removeHandler('pty:management:killOne')
  ipcMain.removeHandler('pty:management:restart')

  ipcMain.handle(
    'pty:management:listSessions',
    async (): Promise<{ sessions: DaemonSessionInfo[] }> => {
      const sessions = await collectSessions(getDaemonAdapters())
      return { sessions }
    }
  )

  // Why: killAll operates on *sessions* (user-facing concept), not daemons, so
  // it fans across every adapter — current + legacy — to match the user's
  // "kill everything I might be attached to" mental model. The daemon
  // processes themselves survive; only sessions are torn down. See
  // docs/daemon-staleness-ux.md §Phase 1 "Scope rationale" for why legacy
  // daemons aren't killed here.
  ipcMain.handle(
    'pty:management:killAll',
    async (): Promise<{ killedCount: number; remainingCount: number }> => {
      const adapters = getDaemonAdapters()
      // Why: snapshot the initial session set once, up front. All subsequent
      // accounting is relative to these IDs. If the renderer respawns panes
      // with *fresh* session IDs while we're polling (e.g. a remount fires
      // pty:spawn mid-kill), those new sessions must not count as
      // "remaining" — the user asked to kill what was alive at the moment
      // they clicked the button, not to chase new spawns.
      const initial = await collectSessions(adapters)
      const initialIds = new Set(initial.map((s) => s.sessionId))
      const initialCount = initial.length

      if (initialCount === 0) {
        return { killedCount: 0, remainingCount: 0 }
      }

      // Why: fire one shutdown per initial session, in parallel, once — no
      // per-session retry. The daemon's session.kill() is idempotent and
      // schedules its own SIGTERM→SIGKILL ladder; firing the RPC repeatedly
      // in a tight retry loop before the grace window expires just races our
      // own polling. Promise.allSettled ensures a single adapter failure (or
      // rejected RPC — e.g. session already exiting) does not short-circuit
      // the remaining shutdowns.
      await Promise.allSettled(
        initial.map(async (session) => {
          // Why: protocolVersion is unique across adapters by construction —
          // PROTOCOL_VERSION is always distinct from every entry in
          // PREVIOUS_DAEMON_PROTOCOL_VERSIONS (see types.ts). If a future
          // bump forgets to rotate the retired version into the previous
          // list, this find() would silently route legacy sessions to the
          // current adapter. Keep the two constants in lockstep.
          const owner = adapters.find((a) => a.protocolVersion === session.protocolVersion)
          if (!owner) {
            return
          }
          // Why: immediate=true is the adapter's "kill it now" signal. The
          // current adapter ignores the flag (the daemon's SIGTERM→SIGKILL
          // ladder handles escalation) but preserve it for legacy adapters
          // and so a future adapter could honor it. Rejections are swallowed
          // per-session — remainingCount surfaces truly-stuck sessions in
          // the toast.
          await owner.shutdown(session.sessionId, true).catch(() => {})
        })
      )

      // Why: poll listSessions every POLL_INTERVAL_MS until none of the
      // *initial* IDs are still alive, or we've exhausted MAX_POLL_ATTEMPTS.
      // Counting only the initial-snapshot intersection (not the total
      // session count) is what keeps the math honest when the renderer
      // respawns panes with fresh IDs mid-kill.
      let remainingOriginalCount = initialCount
      for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
        await sleep(POLL_INTERVAL_MS)
        const current = await collectSessions(adapters)
        remainingOriginalCount = current.reduce(
          (count, s) => (initialIds.has(s.sessionId) ? count + 1 : count),
          0
        )
        if (remainingOriginalCount === 0) {
          break
        }
      }

      const killedCount = initialCount - remainingOriginalCount
      return { killedCount, remainingCount: remainingOriginalCount }
    }
  )

  ipcMain.handle(
    'pty:management:killOne',
    async (_event, args: { sessionId: string }): Promise<{ success: boolean }> => {
      if (typeof args?.sessionId !== 'string' || args.sessionId.length === 0) {
        return { success: false }
      }
      const adapters = getDaemonAdapters()
      const sessions = await collectSessions(adapters)
      const match = sessions.find((s) => s.sessionId === args.sessionId)
      if (!match) {
        return { success: false }
      }
      const owner = adapters.find((a) => a.protocolVersion === match.protocolVersion)
      if (!owner) {
        return { success: false }
      }
      try {
        await owner.shutdown(args.sessionId, true)
        return { success: true }
      } catch {
        return { success: false }
      }
    }
  )

  ipcMain.handle('pty:management:restart', async (): Promise<{ success: boolean }> => {
    try {
      await restartDaemon()
      return { success: true }
    } catch (err) {
      console.error('[pty:management] restart failed', err)
      return { success: false }
    }
  })
}
