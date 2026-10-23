import { ipcMain } from 'electron'
import { DegradedDaemonPtyProvider } from '../daemon/degraded-daemon-pty-provider'
import type { DaemonPtyAdapter } from '../daemon/daemon-pty-adapter'
import {
  getCurrentDaemonMacTccAttributionHealth,
  getDaemonProvider
} from '../daemon/daemon-provider-state'
import { restartDaemon } from '../daemon/daemon-provider-restart'
import {
  readSeveredDaemonStatus,
  restartSeveredDaemon,
  type SeveredDaemonIncarnation,
  type SeveredDaemonRestartResult
} from '../daemon/daemon-host-image-state'
import { getAllDaemonAdapters, getCurrentDaemonAdapter } from '../daemon/daemon-provider-routing'
import { isHoldingForNewerProtocolDaemon } from '../daemon/daemon-newer-protocol-hold'
import {
  getDaemonFolderAccessMismatch,
  refreshDaemonFolderAccessProbe,
  type DaemonFolderAccessMismatchNotice
} from '../daemon/daemon-folder-access-mismatch'
import {
  resetFolderAccessForDaemon,
  type DaemonFolderAccessResetResult
} from '../daemon/daemon-folder-access-reset'
import type { MacDaemonTccAttributionHealth } from '../daemon/daemon-tcc-attribution'
import type { DaemonEndpointIdentity } from '../daemon/daemon-hello-protocol'
import type { DaemonSessionInfo } from '../daemon/types'
import type { DaemonAsyncIoStatus } from '../../shared/daemon-async-io-health'

// Why: poll past the daemon's 5s SIGTERM→SIGKILL ladder (KILL_TIMEOUT_MS in session.ts), else slow-exiting shells falsely look "refused".
// Why a window, not an attempt count: a wedged generation fails each listing only after the request timeout.
const POLL_WINDOW_MS = 6_500
const POLL_INTERVAL_MS = 100

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function getDaemonAdapters(): DaemonPtyAdapter[] {
  const provider = getDaemonProvider()
  return provider ? [...getAllDaemonAdapters(provider)] : []
}

// Why: surface degraded mode (daemon alive but cannot spawn fresh PTYs) so the UI can warn new terminals lack persistence.
function isDaemonDegraded(): boolean {
  const provider = getDaemonProvider()
  return (
    provider instanceof DegradedDaemonPtyProvider &&
    provider.routesFreshSpawnsToLocalProvider === true
  )
}

// Why the current adapter only: evidence is keyed to the daemon now spawning terminals, so a
// legacy adapter's daemon must never satisfy the identity match that keeps the notice up.
function readCurrentDaemonIdentity(): DaemonEndpointIdentity | null {
  const provider = getDaemonProvider()
  return provider ? getCurrentDaemonAdapter(provider).getDaemonIdentity() : null
}

// Why `unlistedVersions`: a generation that failed to list may still own sessions, so its silence is not "none".
async function listSessionsOfEveryAdapter(
  adapters: DaemonPtyAdapter[]
): Promise<{ sessions: DaemonSessionInfo[]; unlistedVersions: Set<number> }> {
  const results = await Promise.allSettled(
    adapters.map(async (adapter) => {
      const sessions = await adapter.listSessions()
      return sessions.map<DaemonSessionInfo>((s) => ({
        ...s,
        protocolVersion: adapter.protocolVersion
      }))
    })
  )
  return {
    sessions: results.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])),
    unlistedVersions: new Set(
      adapters
        .filter((_, index) => results[index].status === 'rejected')
        .map((adapter) => adapter.protocolVersion)
    )
  }
}

async function collectSessions(adapters: DaemonPtyAdapter[]): Promise<DaemonSessionInfo[]> {
  return (await listSessionsOfEveryAdapter(adapters)).sessions
}

export function registerDaemonManagementHandlers(): void {
  ipcMain.removeHandler('pty:management:listSessions')
  ipcMain.removeHandler('pty:management:killAll')
  ipcMain.removeHandler('pty:management:killOne')
  ipcMain.removeHandler('pty:management:restart')
  ipcMain.removeHandler('pty:management:macTccAttribution')
  ipcMain.removeHandler('pty:management:resetFolderAccess')
  ipcMain.removeHandler('pty:management:severedDaemon')
  ipcMain.removeHandler('pty:management:restartSeveredDaemon')
  ipcMain.removeHandler('pty:management:asyncIoHealth')

  ipcMain.handle('pty:management:asyncIoHealth', async (): Promise<DaemonAsyncIoStatus> => {
    const provider = getDaemonProvider()
    if (!provider) {
      return { state: 'unverifiable' }
    }
    const adapter = getCurrentDaemonAdapter(provider)
    const identity = adapter.getDaemonIdentity()
    const health = await adapter.getAsyncIoHealth()
    // A result from a replaced endpoint cannot diagnose its successor.
    return identity && adapter.getDaemonIdentity() === identity && getDaemonProvider() === provider
      ? health
      : { state: 'unverifiable' }
  })

  // Why: a Linux AppImage daemon kept for its live terminals after its files vanished; the
  // banner polls this and offers the verified restart below.
  ipcMain.handle('pty:management:severedDaemon', async () => ({
    severed: await readSeveredDaemonStatus().catch(() => null)
  }))
  ipcMain.handle(
    'pty:management:restartSeveredDaemon',
    async (_event, args: unknown): Promise<SeveredDaemonRestartResult> => {
      const expected = parseSeveredDaemonIncarnation(args)
      if (!expected) {
        return { status: 'refused', reason: 'unverifiable' }
      }
      return restartSeveredDaemon(expected)
    }
  )

  // Why: lets Settings warn that macOS privacy grants no longer reach daemon terminals (STA-3491),
  // and carries the folder-access evidence the notice needs (STA-7948) on the same focus-time poll.
  ipcMain.handle(
    'pty:management:macTccAttribution',
    async (): Promise<{
      health: MacDaemonTccAttributionHealth
      folderAccessMismatch: DaemonFolderAccessMismatchNotice | null
    }> => {
      // Why two guards: the two answers are independent evidence, and a failed health read must
      // not present as "the folder evidence is gone".
      const health = await getCurrentDaemonMacTccAttributionHealth().catch(
        (): MacDaemonTccAttributionHealth => 'unknown'
      )
      const identity = readCurrentDaemonIdentity()
      // Why re-probe on the poll: the fix dialog's first step completes in System Settings, and
      // returning to Orca is the only moment anything can notice. The refresh owns when to skip.
      await refreshDaemonFolderAccessProbe(identity).catch(() => {})
      return { health, folderAccessMismatch: getDaemonFolderAccessMismatch(identity) }
    }
  )

  // Why a separate channel from the poll: this one has a side effect — it clears Orca's TCC row and
  // makes the app touch the folder so macOS re-prompts — and only a user click may trigger it.
  ipcMain.handle(
    'pty:management:resetFolderAccess',
    async (): Promise<DaemonFolderAccessResetResult> => {
      try {
        return await resetFolderAccessForDaemon(readCurrentDaemonIdentity())
      } catch {
        return { outcome: 'unsupported' }
      }
    }
  )

  ipcMain.handle(
    'pty:management:listSessions',
    async (): Promise<{ sessions: DaemonSessionInfo[]; degraded: boolean }> => {
      const sessions = await collectSessions(getDaemonAdapters())
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
      listingIncomplete?: boolean
    }> => {
      const adapters = getDaemonAdapters()
      // Why: snapshot session IDs up front so mid-kill respawns aren't counted as "remaining".
      const { sessions: initial, unlistedVersions } = await listSessionsOfEveryAdapter(adapters)
      const initialIds = new Set(initial.map((s) => s.sessionId))
      const initialCount = initial.length
      // Why: with no adapter (failed startup) or a held newer-build daemon, unlisted sessions can survive.
      const incomplete =
        adapters.length > 0 && unlistedVersions.size === 0 && !isHoldingForNewerProtocolDaemon()
          ? {}
          : { listingIncomplete: true }

      if (initialCount === 0) {
        return { killedCount: 0, remainingCount: 0, killedSessionIds: [], ...incomplete }
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
      let remainingOriginalIds = initialIds
      const pollDeadline = Date.now() + POLL_WINDOW_MS
      while (Date.now() < pollDeadline) {
        await sleep(POLL_INTERVAL_MS)
        const polled = await listSessionsOfEveryAdapter(adapters)
        const listedIds = new Set(polled.sessions.map((session) => session.sessionId))
        // Why per generation: an answer proves its own sessions' state; a failed one keeps the last confirmed state.
        remainingOriginalIds = new Set(
          initial
            .filter(
              (session) =>
                remainingOriginalIds.has(session.sessionId) &&
                (polled.unlistedVersions.has(session.protocolVersion) ||
                  listedIds.has(session.sessionId))
            )
            .map((session) => session.sessionId)
        )
        if (remainingOriginalIds.size === 0) {
          break
        }
      }

      const remainingOriginalCount = remainingOriginalIds.size
      const killedCount = initialCount - remainingOriginalCount
      return {
        killedCount,
        remainingCount: remainingOriginalCount,
        killedSessionIds: [...initialIds].filter(
          (sessionId) => !remainingOriginalIds.has(sessionId)
        ),
        ...incomplete
      }
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

function parseSeveredDaemonIncarnation(args: unknown): SeveredDaemonIncarnation | null {
  if (
    typeof args !== 'object' ||
    args === null ||
    !('pid' in args) ||
    !('linuxStartTicks' in args) ||
    !('bootId' in args)
  ) {
    return null
  }
  const { pid, linuxStartTicks, bootId } = args
  return typeof pid === 'number' &&
    Number.isSafeInteger(pid) &&
    pid > 0 &&
    typeof linuxStartTicks === 'string' &&
    typeof bootId === 'string'
    ? { pid, linuxStartTicks, bootId }
    : null
}
