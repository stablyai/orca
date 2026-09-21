import { ipcMain } from 'electron'
import { DaemonPtyRouter } from '../daemon/daemon-pty-router'
import { DegradedDaemonPtyProvider } from '../daemon/degraded-daemon-pty-provider'
import type { DaemonPtyAdapter } from '../daemon/daemon-pty-adapter'
import {
  getCurrentDaemonMacTccAttributionHealth,
  getDaemonProvider,
  restartDaemon
} from '../daemon/daemon-init'
import type { MacDaemonTccAttributionHealth } from '../daemon/daemon-tcc-attribution'
import type { DaemonSessionInfo } from '../daemon/types'

// Why: poll past the daemon's 5s SIGTERM→SIGKILL ladder (KILL_TIMEOUT_MS in session.ts), else slow-exiting shells falsely look "refused".
const MAX_POLL_ATTEMPTS = 65
const POLL_INTERVAL_MS = 100

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

type DaemonAdapterSet = { adapters: DaemonPtyAdapter[]; current: DaemonPtyAdapter | null }

// Why: the current generation is whichever adapter the router routes fresh spawns to, not
// whichever one matches PROTOCOL_VERSION — an adopted daemon can be current on an older protocol.
function getDaemonAdapters(): DaemonAdapterSet {
  const provider = getDaemonProvider()
  if (!provider) {
    return { adapters: [], current: null }
  }
  if (provider instanceof DaemonPtyRouter || provider instanceof DegradedDaemonPtyProvider) {
    return { adapters: [...provider.getAllAdapters()], current: provider.getCurrentAdapter() }
  }
  return { adapters: [provider], current: provider }
}

// Why: surface degraded mode (daemon alive but cannot spawn fresh PTYs) so the UI can warn new terminals lack persistence.
function isDaemonDegraded(): boolean {
  const provider = getDaemonProvider()
  return (
    provider instanceof DegradedDaemonPtyProvider &&
    provider.routesFreshSpawnsToLocalProvider === true
  )
}

/**
 * One daemon protocol generation and what this process actually knows about it.
 *
 * A generation whose adapter did not answer is `unverifiable` and carries no session list at
 * all: an empty array would read as a counted zero, and absence from a client-side listing is
 * never evidence that the generation's PTYs exited (docs/reference/ssh-execution-boundary.md).
 * Only two of that document's contact arms appear here because a daemon adapter either answered
 * this listing or it did not — this channel has no refuse or retire signal to report.
 */
export type DaemonGenerationInventory = { protocolVersion: number; isCurrent: boolean } & (
  | { contact: 'live'; sessions: DaemonSessionInfo[] }
  | { contact: 'unverifiable'; reason: 'listing-failed'; detail: string | null }
)

async function collectGenerations({
  adapters,
  current
}: DaemonAdapterSet): Promise<DaemonGenerationInventory[]> {
  return Promise.all(
    adapters.map(async (adapter): Promise<DaemonGenerationInventory> => {
      const generation = {
        protocolVersion: adapter.protocolVersion,
        isCurrent: adapter === current
      }
      try {
        const sessions = await adapter.listSessions()
        return {
          ...generation,
          contact: 'live',
          sessions: sessions.map<DaemonSessionInfo>((s) => ({
            ...s,
            protocolVersion: adapter.protocolVersion
          }))
        }
      } catch (err) {
        return {
          ...generation,
          contact: 'unverifiable',
          reason: 'listing-failed',
          detail: err instanceof Error ? err.message : null
        }
      }
    })
  )
}

// Why named rather than inlined: kill routing can only reach sessions a generation actually
// reported, so the narrowing is a stated limit of the kill surface, not a dropped error.
function reachableSessions(generations: DaemonGenerationInventory[]): DaemonSessionInfo[] {
  return generations.flatMap((g) => (g.contact === 'live' ? g.sessions : []))
}

async function collectSessions(adapterSet: DaemonAdapterSet): Promise<DaemonSessionInfo[]> {
  return reachableSessions(await collectGenerations(adapterSet))
}

export function registerDaemonManagementHandlers(): void {
  ipcMain.removeHandler('pty:management:listSessions')
  ipcMain.removeHandler('pty:management:killAll')
  ipcMain.removeHandler('pty:management:killOne')
  ipcMain.removeHandler('pty:management:restart')
  ipcMain.removeHandler('pty:management:macTccAttribution')

  // Why: lets Settings warn that macOS privacy grants no longer reach daemon terminals (STA-3491).
  ipcMain.handle(
    'pty:management:macTccAttribution',
    async (): Promise<{ health: MacDaemonTccAttributionHealth }> => {
      try {
        return { health: await getCurrentDaemonMacTccAttributionHealth() }
      } catch {
        return { health: 'unknown' }
      }
    }
  )

  ipcMain.handle(
    'pty:management:listSessions',
    async (): Promise<{ generations: DaemonGenerationInventory[]; degraded: boolean }> => {
      const generations = await collectGenerations(getDaemonAdapters())
      return { generations, degraded: isDaemonDegraded() }
    }
  )

  // Why: tears down sessions across all adapters (current + legacy); daemon processes survive. See docs/daemon-staleness-ux.md §Phase 1.
  ipcMain.handle(
    'pty:management:killAll',
    async (): Promise<{
      killedCount: number
      remainingCount: number
      killedSessionIds: string[]
    }> => {
      const adapterSet = getDaemonAdapters()
      const adapters = adapterSet.adapters
      // Why: snapshot session IDs up front so mid-kill respawns aren't counted as "remaining".
      const initial = await collectSessions(adapterSet)
      const initialIds = new Set(initial.map((s) => s.sessionId))
      const initialCount = initial.length

      if (initialCount === 0) {
        return { killedCount: 0, remainingCount: 0, killedSessionIds: [] }
      }

      // Why: no retry — session.kill() is idempotent and runs its own kill ladder; allSettled so one rejection doesn't abort the rest.
      await Promise.allSettled(
        initial.map(async (session) => {
          // Why: assumes PROTOCOL_VERSION stays distinct from PREVIOUS_DAEMON_PROTOCOL_VERSIONS (types.ts), else legacy sessions misroute here.
          const owner = adapters.find((a) => a.protocolVersion === session.protocolVersion)
          if (!owner) {
            return
          }
          // Why: immediate=true only matters to legacy/future adapters; swallow rejections since remainingCount reports stuck sessions.
          await owner.shutdown(session.sessionId, { immediate: true }).catch(() => {})
        })
      )

      // Why: count only the initial-snapshot intersection so renderer respawns mid-kill aren't counted as remaining.
      let remainingOriginalCount = initialCount
      let remainingOriginalIds = initialIds
      for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
        await sleep(POLL_INTERVAL_MS)
        const current = await collectSessions(adapterSet)
        remainingOriginalIds = new Set(
          current
            .filter((session) => initialIds.has(session.sessionId))
            .map((session) => session.sessionId)
        )
        remainingOriginalCount = remainingOriginalIds.size
        if (remainingOriginalCount === 0) {
          break
        }
      }

      const killedCount = initialCount - remainingOriginalCount
      return {
        killedCount,
        remainingCount: remainingOriginalCount,
        killedSessionIds: [...initialIds].filter(
          (sessionId) => !remainingOriginalIds.has(sessionId)
        )
      }
    }
  )

  ipcMain.handle(
    'pty:management:killOne',
    async (_event, args: { sessionId: string }): Promise<{ success: boolean }> => {
      if (typeof args?.sessionId !== 'string' || args.sessionId.length === 0) {
        return { success: false }
      }
      const adapterSet = getDaemonAdapters()
      const sessions = await collectSessions(adapterSet)
      const match = sessions.find((s) => s.sessionId === args.sessionId)
      if (!match) {
        return { success: false }
      }
      const owner = adapterSet.adapters.find((a) => a.protocolVersion === match.protocolVersion)
      if (!owner) {
        return { success: false }
      }
      try {
        await owner.shutdown(args.sessionId, { immediate: true })
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
