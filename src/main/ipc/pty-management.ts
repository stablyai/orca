import { ipcMain } from 'electron'
import { DaemonPtyRouter } from '../daemon/daemon-pty-router'
import { DegradedDaemonPtyProvider } from '../daemon/degraded-daemon-pty-provider'
import type { DaemonPtyAdapter } from '../daemon/daemon-pty-adapter'
import { getDaemonProvider, restartDaemon } from '../daemon/daemon-init'
import type { DaemonSessionInfo } from '../daemon/types'

// Why: poll past the daemon's 5s SIGTERM→SIGKILL ladder (KILL_TIMEOUT_MS in session.ts), else slow-exiting shells falsely look "refused".
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
  if (provider instanceof DaemonPtyRouter || provider instanceof DegradedDaemonPtyProvider) {
    return [...provider.getAllAdapters()]
  }
  return [provider]
}

// Why: surface degraded mode (daemon alive but cannot spawn fresh PTYs) so the UI can warn new terminals lack persistence.
function isDaemonDegraded(): boolean {
  return getDaemonProvider() instanceof DegradedDaemonPtyProvider
}

type OwnedDaemonSession = {
  owner: DaemonPtyAdapter
  session: DaemonSessionInfo
}

type DaemonSessionCollection = {
  sessions: OwnedDaemonSession[]
  unavailableOwners: Set<DaemonPtyAdapter>
}

async function collectSessions(adapters: DaemonPtyAdapter[]): Promise<DaemonSessionCollection> {
  const results = await Promise.allSettled(
    adapters.map(async (adapter) => {
      const sessions = await adapter.listSessions()
      return sessions.map((session) => ({
        owner: adapter,
        session: { ...session, protocolVersion: adapter.protocolVersion }
      }))
    })
  )
  const sessions: OwnedDaemonSession[] = []
  const unavailableOwners = new Set<DaemonPtyAdapter>()
  for (const [index, result] of results.entries()) {
    if (result.status === 'fulfilled') {
      sessions.push(...result.value)
    } else {
      unavailableOwners.add(adapters[index])
    }
  }
  return { sessions, unavailableOwners }
}

type DaemonSessionIncarnationBucket = {
  hasUnqualifiedSession: boolean
  incarnationIds: Set<string>
}

function indexSessionIncarnations(
  sessions: readonly OwnedDaemonSession[]
): Map<DaemonPtyAdapter, Map<string, DaemonSessionIncarnationBucket>> {
  const byOwner = new Map<DaemonPtyAdapter, Map<string, DaemonSessionIncarnationBucket>>()
  for (const { owner, session } of sessions) {
    let bySessionId = byOwner.get(owner)
    if (!bySessionId) {
      bySessionId = new Map()
      byOwner.set(owner, bySessionId)
    }
    let bucket = bySessionId.get(session.sessionId)
    if (!bucket) {
      bucket = { hasUnqualifiedSession: false, incarnationIds: new Set() }
      bySessionId.set(session.sessionId, bucket)
    }
    if (session.incarnationId === undefined) {
      bucket.hasUnqualifiedSession = true
    } else {
      bucket.incarnationIds.add(session.incarnationId)
    }
  }
  return byOwner
}

function hasSessionIncarnation(
  index: ReadonlyMap<DaemonPtyAdapter, ReadonlyMap<string, DaemonSessionIncarnationBucket>>,
  original: OwnedDaemonSession
): boolean {
  const bucket = index.get(original.owner)?.get(original.session.sessionId)
  return (
    bucket !== undefined &&
    (original.session.incarnationId === undefined ||
      bucket.hasUnqualifiedSession ||
      bucket.incarnationIds.has(original.session.incarnationId))
  )
}

export function registerDaemonManagementHandlers(): void {
  ipcMain.removeHandler('pty:management:listSessions')
  ipcMain.removeHandler('pty:management:killAll')
  ipcMain.removeHandler('pty:management:killOne')
  ipcMain.removeHandler('pty:management:restart')

  ipcMain.handle(
    'pty:management:listSessions',
    async (): Promise<{ sessions: DaemonSessionInfo[]; degraded: boolean }> => {
      const sessions = (await collectSessions(getDaemonAdapters())).sessions.map(
        ({ session }) => session
      )
      return { sessions, degraded: isDaemonDegraded() }
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
      const adapters = getDaemonAdapters()
      const initialCollection = await collectSessions(adapters)
      if (initialCollection.unavailableOwners.size > 0) {
        throw new Error('Cannot kill daemon sessions while session inventory is unavailable')
      }
      const initial = initialCollection.sessions
      const initialCount = initial.length

      if (initialCount === 0) {
        return { killedCount: 0, remainingCount: 0, killedSessionIds: [] }
      }

      // Why: no retry — session.kill() is idempotent and runs its own kill ladder; allSettled so one rejection doesn't abort the rest.
      await Promise.allSettled(
        initial.map(async ({ owner, session }) => {
          // Why: immediate=true only matters to legacy/future adapters; swallow rejections since remainingCount reports stuck sessions.
          await owner.shutdown(session.sessionId, { immediate: true }).catch(() => {})
        })
      )

      // Why: count only the initial-snapshot intersection so renderer respawns mid-kill aren't counted as remaining.
      let remainingOriginal = initial
      let pollingAdapters = adapters
      const unavailableOwners = new Set<DaemonPtyAdapter>()
      for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
        await sleep(POLL_INTERVAL_MS)
        const current = await collectSessions(pollingAdapters)
        for (const owner of current.unavailableOwners) {
          unavailableOwners.add(owner)
        }
        const currentIndex = indexSessionIncarnations(current.sessions)
        remainingOriginal = initial.filter(
          (original) =>
            unavailableOwners.has(original.owner) || hasSessionIncarnation(currentIndex, original)
        )
        if (remainingOriginal.length === 0) {
          break
        }
        const remainingOwners = new Set(remainingOriginal.map(({ owner }) => owner))
        pollingAdapters = pollingAdapters.filter(
          (adapter) => remainingOwners.has(adapter) && !unavailableOwners.has(adapter)
        )
        if (pollingAdapters.length === 0) {
          break
        }
      }

      const remainingSet = new Set(remainingOriginal)
      const killed = initial.filter((original) => !remainingSet.has(original))
      return {
        killedCount: killed.length,
        remainingCount: remainingOriginal.length,
        killedSessionIds: killed.map(({ session }) => session.sessionId)
      }
    }
  )

  ipcMain.handle(
    'pty:management:killOne',
    async (
      _event,
      args: { sessionId: string; protocolVersion?: number; incarnationId?: string }
    ): Promise<{ success: boolean }> => {
      if (typeof args?.sessionId !== 'string' || args.sessionId.length === 0) {
        return { success: false }
      }
      const adapters = getDaemonAdapters()
      const collection = await collectSessions(adapters)
      if (collection.unavailableOwners.size > 0) {
        return { success: false }
      }
      const matches = collection.sessions.filter(
        ({ session }) =>
          session.sessionId === args.sessionId &&
          (args.protocolVersion === undefined ||
            session.protocolVersion === args.protocolVersion) &&
          (args.incarnationId === undefined || session.incarnationId === args.incarnationId)
      )
      if (matches.length !== 1) {
        return { success: false }
      }
      const [{ owner }] = matches
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
