import { ipcMain } from 'electron'
import { DaemonPtyRouter } from '../daemon/daemon-pty-router'
import { DegradedDaemonPtyProvider } from '../daemon/degraded-daemon-pty-provider'
import {
  getCurrentDaemonMacTccAttributionHealth,
  getDaemonProvider,
  restartDaemon
} from '../daemon/daemon-init'
import { getCurrentDaemonAdapter } from '../daemon/daemon-provider-routing'
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
import { USER_FACING_DAEMON_LISTING_TIMEOUT_MS } from '../daemon/daemon-generation-listing'
import {
  collectGenerations,
  generationDeadline,
  type DaemonAdapterSet,
  type DaemonGenerationInventory
} from './pty-management-generations'
import { killAllDaemonSessions, type DaemonKillAllResult } from './pty-management-kill-all'

export type { DaemonGenerationInventory } from './pty-management-generations'

// Why identity, not PROTOCOL_VERSION: current is the adapter the router spawns fresh sessions on.
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

// Why the current adapter only: evidence is keyed to the daemon now spawning terminals, so a
// legacy adapter's daemon must never satisfy the identity match that keeps the notice up.
function readCurrentDaemonIdentity(): DaemonEndpointIdentity | null {
  const provider = getDaemonProvider()
  return provider ? getCurrentDaemonAdapter(provider).getDaemonIdentity() : null
}

export function registerDaemonManagementHandlers(
  deps: {
    /** Reads the incarnation saved tabs recorded for a session id (savedPaneIncarnation). */
    getSavedIncarnationLookup?: () => (sessionId: string) => string | undefined
  } = {}
): void {
  ipcMain.removeHandler('pty:management:listSessions')
  ipcMain.removeHandler('pty:management:killAll')
  ipcMain.removeHandler('pty:management:killOne')
  ipcMain.removeHandler('pty:management:restart')
  ipcMain.removeHandler('pty:management:macTccAttribution')
  ipcMain.removeHandler('pty:management:resetFolderAccess')

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
    async (): Promise<{ generations: DaemonGenerationInventory[]; degraded: boolean }> => {
      const generations = await collectGenerations(
        getDaemonAdapters(),
        undefined,
        deps.getSavedIncarnationLookup?.()
      )
      return { generations, degraded: isDaemonDegraded() }
    }
  )

  // Why: tears down sessions across all adapters (current + legacy); daemon processes survive. See docs/daemon-staleness-ux.md §Phase 1.
  ipcMain.handle(
    'pty:management:killAll',
    async (): Promise<DaemonKillAllResult> => await killAllDaemonSessions(getDaemonAdapters())
  )

  ipcMain.handle(
    'pty:management:killOne',
    async (
      _event,
      args: { sessionId: string; protocolVersion: number; incarnationId?: string }
    ): Promise<{ success: boolean; reason?: 'unverifiable' }> => {
      if (
        typeof args?.sessionId !== 'string' ||
        args.sessionId.length === 0 ||
        typeof args.protocolVersion !== 'number'
      ) {
        return { success: false }
      }
      // Why the clicked row's exact identity: after a fresh start over an unreachable version the
      // same id is live in two versions, and killing the first match ended the tab's own agent.
      const { adapters, current } = getDaemonAdapters()
      const owner = adapters.find((a) => a.protocolVersion === args.protocolVersion)
      if (!owner) {
        return { success: false }
      }
      let listed
      try {
        const deadlineMs = generationDeadline(
          owner,
          current,
          Date.now() + USER_FACING_DAEMON_LISTING_TIMEOUT_MS
        )
        listed = await owner.readSessions(deadlineMs === undefined ? undefined : { deadlineMs })
      } catch {
        // Why not "already gone": losing contact with the version is not evidence the session ended.
        return { success: false, reason: 'unverifiable' }
      }
      const match =
        listed.contact === 'live' &&
        listed.items.some(
          (s) =>
            s.sessionId === args.sessionId &&
            (args.incarnationId === undefined || s.incarnationId === args.incarnationId)
        )
      if (!match) {
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
