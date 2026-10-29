import { ipcMain } from 'electron'
import { DegradedDaemonPtyProvider } from '../../daemon/degraded-daemon-pty-provider'
import type { DaemonPtyAdapter } from '../../daemon/daemon-pty-adapter'
import {
  getCurrentDaemonMacTccAttributionHealth,
  getDaemonProvider
} from '../../daemon/daemon-provider-state'
import { restartDaemon } from '../../daemon/daemon-provider-restart'
import {
  readSeveredDaemonStatus,
  restartSeveredDaemon,
  type SeveredDaemonIncarnation,
  type SeveredDaemonRestartResult
} from '../../daemon/daemon-host-image-state'
import { getAllDaemonAdapters, getCurrentDaemonAdapter } from '../../daemon/daemon-provider-routing'
import { isHoldingForNewerProtocolDaemon } from '../../daemon/daemon-newer-protocol-hold'
import {
  getDaemonFolderAccessMismatch,
  refreshDaemonFolderAccessProbe,
  type DaemonFolderAccessMismatchNotice
} from '../../daemon/daemon-folder-access-mismatch'
import {
  resetFolderAccessForDaemon,
  type DaemonFolderAccessResetResult
} from '../../daemon/daemon-folder-access-reset'
import type { MacDaemonTccAttributionHealth } from '../../daemon/daemon-tcc-attribution'
import type { DaemonEndpointIdentity } from '../../daemon/daemon-hello-protocol'
import { sameEndpointIdentity } from '../../daemon/daemon-endpoint-incarnation'
import type { DaemonSessionInfo } from '../../daemon/daemon-session-info'
import type { DaemonAsyncIoStatus } from '../../../shared/daemon-async-io-health'

// Poll beyond the daemon's 5s SIGTERM-to-SIGKILL ladder to avoid false refusal reports.
// A window, not an attempt count: a wedged generation fails each listing only after the request timeout.
const POLL_WINDOW_MS = 6_500
const POLL_INTERVAL_MS = 100

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function getDaemonAdapters(): DaemonPtyAdapter[] {
  const provider = getDaemonProvider()
  return provider ? [...getAllDaemonAdapters(provider)] : []
}

// A live daemon unable to spawn means new terminals lack persistence.
function isDaemonDegraded(): boolean {
  const provider = getDaemonProvider()
  return (
    provider instanceof DegradedDaemonPtyProvider &&
    provider.routesFreshSpawnsToLocalProvider === true
  )
}

// Match folder-access evidence against the current spawning daemon, never a legacy adapter.
function readCurrentDaemonIdentity(): DaemonEndpointIdentity | null {
  const provider = getDaemonProvider()
  return provider ? getCurrentDaemonAdapter(provider).getDaemonIdentity() : null
}

// A generation that failed to list may still own sessions, so its silence is not "none".
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

// With no adapter (failed startup) or a held newer-build daemon, unlisted sessions can survive.
function listedEveryGeneration(
  adapters: DaemonPtyAdapter[],
  unlistedVersions: Set<number>
): boolean {
  return adapters.length > 0 && unlistedVersions.size === 0 && !isHoldingForNewerProtocolDaemon()
}

async function collectSessions(adapters: DaemonPtyAdapter[]): Promise<DaemonSessionInfo[]> {
  return (await listSessionsOfEveryAdapter(adapters)).sessions
}

// Kill all counts only its first listing; a session started since (CLI, automation) would outlive the quit.
// Polls so the tab sweep's exact kills can settle.
export async function confirmNoDaemonSessionsRemain(): Promise<boolean> {
  const adapters = getDaemonAdapters()
  // Why: neither can change within the poll window, so waiting it out only delays the refusal.
  if (!listedEveryGeneration(adapters, new Set())) {
    return false
  }
  const pollDeadline = Date.now() + POLL_WINDOW_MS
  do {
    const { sessions, unlistedVersions } = await listSessionsOfEveryAdapter(adapters)
    if (sessions.length === 0 && listedEveryGeneration(adapters, unlistedVersions)) {
      return true
    }
    await sleep(POLL_INTERVAL_MS)
  } while (Date.now() < pollDeadline)
  return false
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
    const current = adapter.getDaemonIdentity()
    return identity &&
      current &&
      sameEndpointIdentity(identity, current) &&
      getDaemonProvider() === provider
      ? health
      : { state: 'unverifiable' }
  })

  // Live terminals may outlast deleted AppImage runtime files; offer verified restart recovery.
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

  // The focus-time poll carries macOS attribution and folder-access evidence (STA-3491, STA-7948).
  ipcMain.handle(
    'pty:management:macTccAttribution',
    async (): Promise<{
      health: MacDaemonTccAttributionHealth
      folderAccessMismatch: DaemonFolderAccessMismatchNotice | null
    }> => {
      // Independent evidence reads must not erase folder-access state when health probing fails.
      const health = await getCurrentDaemonMacTccAttributionHealth().catch(
        (): MacDaemonTccAttributionHealth => 'unknown'
      )
      const identity = readCurrentDaemonIdentity()
      // Returning from System Settings is the opportunity to detect completed repair.
      await refreshDaemonFolderAccessProbe(identity).catch(() => {})
      return { health, folderAccessMismatch: getDaemonFolderAccessMismatch(identity) }
    }
  )

  // Clearing TCC state and prompting require an explicit user action; keep them out of polling.
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

  // Stop sessions across current and legacy adapters while leaving daemon processes alive.
  ipcMain.handle(
    'pty:management:killAll',
    async (): Promise<{
      killedCount: number
      remainingCount: number
      killedSessionIds: string[]
      listingIncomplete?: boolean
    }> => {
      const adapters = getDaemonAdapters()
      // Exclude panes respawned after the user requested killAll.
      const { sessions: initial, unlistedVersions } = await listSessionsOfEveryAdapter(adapters)
      const initialIds = new Set(initial.map((s) => s.sessionId))
      const initialCount = initial.length
      const incomplete = listedEveryGeneration(adapters, unlistedVersions)
        ? {}
        : { listingIncomplete: true }

      if (initialCount === 0) {
        return { killedCount: 0, remainingCount: 0, killedSessionIds: [], ...incomplete }
      }

      // Each session owns its kill ladder; one rejection must not abort the others.
      await Promise.allSettled(
        initial.map(async (session) => {
          // Current and legacy protocol versions must remain distinct to route to the owning adapter.
          const owner = adapters.find((a) => a.protocolVersion === session.protocolVersion)
          if (!owner) {
            return
          }
          // Legacy/future adapters may use immediate; stuck sessions are reported by remainingCount.
          await owner.shutdown(session.sessionId, { immediate: true }).catch(() => {})
        })
      )

      let remainingOriginalIds = initialIds
      const pollDeadline = Date.now() + POLL_WINDOW_MS
      while (Date.now() < pollDeadline) {
        await sleep(POLL_INTERVAL_MS)
        const polled = await listSessionsOfEveryAdapter(adapters)
        const listedIds = new Set(polled.sessions.map((session) => session.sessionId))
        // Per generation: an answer proves its own sessions' state; a failed one keeps the last confirmed state.
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
