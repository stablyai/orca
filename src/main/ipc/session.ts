import { ipcMain } from 'electron'
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { parseTerminalSurfaceCloseTarget } from '../../shared/terminal-surface-close-target'
import { isFrozenOrcadSourceSessionPartition } from '../ssh/orcad-retained-source'
import { isWslMoveWindowWriteHeld } from '../persistence/moving-wsl-projects/wsl-move-window-write-hold'
import { visibleSessionHostIds } from '../ssh/orcad-retained-source-session'
import { markAgentLaunchesClosedByUser } from '../agent-launch/agent-launch-pane-attachment'
import { windowViewPatchForMain, windowViewSaveForMain } from '../persistence/window-save-view'
import { reportWindowSaveDrift } from '../persistence/window-save-divergence'
import { windowSaveKeepingMainSleepRecords } from '../persistence/window-save-sleep-records'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../shared/layout-owner-switch'
import type {
  WorkspaceSessionPatch,
  WorkspaceSessionState
} from '../../shared/workspace-session-state-types'

export function registerSessionHandlers(store: Store, runtime: OrcaRuntimeService): void {
  // Why: renderer saves would change a fenced host's frozen source partition, or write back what a
  // WSL move rewrote under this window before main reloads it.
  const isFenced = (hostId?: string | null): boolean =>
    isFrozenOrcadSourceSessionPartition(store, hostId) || isWslMoveWindowWriteHeld()

  // Optional hostId preserves local-partition behavior for older renderers.
  ipcMain.handle('session:get', (_event, hostId?: string | null) => {
    return store.getWorkspaceSession(hostId)
  })

  // Repo catalogs omit folder-only SSH hosts; enumerate session partitions directly (#12723).
  ipcMain.handle('session:list-host-ids', () => {
    return visibleSessionHostIds(store, store.getWorkspaceSessionHostIds())
  })

  // Main owns layout membership; merge the window's view and facts, then report layout drift.
  const sessionForMain = (args: WorkspaceSessionState, hostId: string | null | undefined) => {
    const stored = store.getWorkspaceSession(hostId)
    reportWindowSaveDrift(stored, args, hostId, 'session:set')
    return windowViewSaveForMain(stored, args, hostId, (session, partition) =>
      runtime.shutdownReconnectFactsFor(session, partition)
    )
  }
  const patchForMain = (args: WorkspaceSessionPatch, hostId: string | null | undefined) => {
    const stored = store.getWorkspaceSession(hostId)
    reportWindowSaveDrift(stored, { ...stored, ...args }, hostId, 'session:patch')
    return windowViewPatchForMain(stored, args, hostId, (session, partition) =>
      runtime.shutdownReconnectFactsFor(session, partition)
    )
  }

  ipcMain.handle('session:set', (_event, args: WorkspaceSessionState, hostId?: string | null) => {
    if (!isFenced(hostId)) {
      store.setWorkspaceSession(
        ORCA_LAYOUT_OWNER_IS_MAIN
          ? sessionForMain(args, hostId)
          : windowSaveKeepingMainSleepRecords(store.getWorkspaceSession(hostId), args, 'set'),
        hostId
      )
    }
  })

  ipcMain.handle('session:patch', (_event, args: WorkspaceSessionPatch, hostId?: string | null) => {
    if (!isFenced(hostId)) {
      store.patchWorkspaceSession(
        ORCA_LAYOUT_OWNER_IS_MAIN
          ? patchForMain(args, hostId)
          : windowSaveKeepingMainSleepRecords(store.getWorkspaceSession(hostId), args, 'patch'),
        hostId
      )
    }
  })

  // Window saves cannot shrink main-owned membership; closes must commit explicitly.
  ipcMain.handle(
    'session:close-terminal-surface',
    (_event, args: { worktreeId?: unknown; target?: unknown; reason?: unknown } | undefined) => {
      const target = parseTerminalSurfaceCloseTarget(args?.target)
      if (typeof args?.worktreeId !== 'string' || !target) {
        throw new Error('invalid_terminal_surface')
      }
      // Only main may close tabs for process exit.
      const reason = args.reason === 'cleanup' ? 'cleanup' : 'user'
      if (reason === 'user') {
        markAgentLaunchesClosedByUser(args.worktreeId, target)
      }
      return runtime.closeTerminalSurfaceFromRenderer({
        worktreeId: args.worktreeId,
        target,
        reason
      })
    }
  )

  ipcMain.handle('session:flush', () => {
    // Lifecycle success requires durable writes; Store.flush only logs failures.
    return store.flushPendingOrThrowAsync()
  })

  ipcMain.on(
    'session:read-terminal-scrollback-sync',
    (event, args: { ref?: unknown } | undefined) => {
      event.returnValue =
        typeof args?.ref === 'string' ? store.readTerminalScrollbackSnapshot(args.ref) : null
    }
  )

  // Why: render-time planning only needs to know a local copy exists; a stat never reads bytes.
  ipcMain.on(
    'session:has-terminal-scrollback-sync',
    (event, args: { ref?: unknown } | undefined) => {
      event.returnValue =
        typeof args?.ref === 'string' ? store.hasTerminalScrollbackSnapshot(args.ref) : false
    }
  )
}
