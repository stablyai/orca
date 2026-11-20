import { ipcMain } from 'electron'
import type { Store } from '../persistence/loading-store/store'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { parseTerminalSurfaceCloseTarget } from '../../shared/workspace-layout/terminal-surfaces/terminal-surface-close-target'
import { isFrozenOrcadSourceSessionPartition } from '../persistence/migrating-orcad-catalog/source/catalog/orcad-source-visibility'
import { isWslMoveWindowWriteHeld } from '../persistence/moving-wsl-projects/quiescence/wsl-move-window-write-hold'
import { visibleSessionHostIds } from '../persistence/migrating-orcad-catalog/retained-source/orcad-retained-source-session'
import { markAgentLaunchesClosedByUser } from '../agent-launch/agent-launch-pane-attachment'
import { windowViewPatchForMain, windowViewSaveForMain } from '../persistence/window-save-view'
import { windowWrittenWorkspaces } from '../persistence/window-session-written-workspaces'
import { reportWindowSaveDrift } from '../persistence/window-save-divergence'
import { windowSaveKeepingMainSleepRecords } from '../persistence/window-save-sleep-records'
import { isNoopWindowSessionPatch } from '../persistence/window-session-patch-noop'
import { noteWindowSessionSaveUnchanged } from '../browser/extensions/tabs-and-windows/browser-extension-discarded-tabs'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../shared/workspace-layout/layout-owner-switch'
import type {
  WorkspaceSessionPatch,
  WorkspaceSessionState
} from '../../shared/workspace-session/workspace-session-state-types'
import {
  applyWorkspaceSessionEntriesPatch,
  fieldsStoredDifferently,
  type WorkspaceSessionEntriesPatch,
  type WorkspaceSessionEntriesPatchResult
} from '../../shared/workspace-session/workspace-session-entries-patch'

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
  /** `entries`: the window's changed keys, when it sent only those. */
  const patchForMain = (
    args: WorkspaceSessionPatch,
    hostId: string | null | undefined,
    entries?: WorkspaceSessionEntriesPatch
  ) => {
    const stored = store.getWorkspaceSession(hostId)
    reportWindowSaveDrift(stored, { ...stored, ...args }, hostId, 'session:patch')
    const { patch, touched } = windowViewPatchForMain(stored, args, hostId, (session, partition) =>
      runtime.shutdownReconnectFactsFor(session, partition)
    )
    // Main merges layout fields itself, so the keys it wrote bound what the save changes.
    return {
      save: patch,
      written: touched ? windowWrittenWorkspaces(stored, patch, touched, entries) : undefined
    }
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

  const patchWindowSession = (
    toPatch: (stored: WorkspaceSessionState) => WorkspaceSessionPatch,
    hostId: string | null | undefined,
    entries?: WorkspaceSessionEntriesPatch
  ): WorkspaceSessionEntriesPatchResult['status'] => {
    if (isFenced(hostId)) {
      return 'skipped'
    }
    const stored = store.getWorkspaceSession(hostId)
    const args = toPatch(stored)
    const { save, written } = ORCA_LAYOUT_OWNER_IS_MAIN
      ? patchForMain(args, hostId, entries)
      : { save: windowSaveKeepingMainSleepRecords(stored, args, 'patch'), written: undefined }
    if (!ORCA_LAYOUT_OWNER_IS_MAIN && isNoopWindowSessionPatch(stored, save)) {
      noteWindowSessionSaveUnchanged(hostId)
      return 'unchanged'
    }
    store.patchWorkspaceSession(save, hostId, written)
    return 'applied'
  }

  ipcMain.handle('session:patch', (_event, args: WorkspaceSessionPatch, hostId?: string | null) => {
    patchWindowSession(() => args, hostId)
  })

  // Changed keys only: rebuilt into whole fields from the stored partition, then saved as a patch.
  ipcMain.handle(
    'session:patch-entries',
    (
      _event,
      args: WorkspaceSessionEntriesPatch,
      hostId?: string | null
    ): WorkspaceSessionEntriesPatchResult => {
      const status = patchWindowSession(
        (stored) => applyWorkspaceSessionEntriesPatch(stored, args),
        hostId,
        args
      )
      if (status === 'skipped') {
        return { status }
      }
      // Normalization, fences and main's sleep records can store something else, saved or not.
      const normalizedFields = fieldsStoredDifferently(store.getWorkspaceSession(hostId), args)
      return normalizedFields.length > 0 ? { status, normalizedFields } : { status }
    }
  )

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

  ipcMain.handle(
    'session:read-terminal-scrollback',
    (_event, args: { ref?: unknown } | undefined) =>
      typeof args?.ref === 'string' ? store.readTerminalScrollbackSnapshotAsync(args.ref) : null
  )
}
