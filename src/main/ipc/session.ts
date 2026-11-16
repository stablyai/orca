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
import {
  windowSaveKeepingRelayOwnership,
  type WindowSessionSetOptions
} from '../persistence/window-save-relay-ownership'
import {
  carriedRelayStatus,
  parseCarriedDesktopRelays,
  registerDesktopRelayHandlers
} from './session-desktop-relays'
import type { WorkspaceSessionSetResult } from '../../shared/workspace-session/desktop-relay-write'
import type { DesktopRelayHostWrite } from '../../shared/workspace-session/desktop-relay-ownership'
import { isNoopWindowSessionPatch } from '../persistence/window-session-patch-noop'
import { noteWindowSessionSaveUnchanged } from '../browser/extensions/tabs-and-windows/browser-extension-discarded-tabs'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../shared/workspace-layout/layout-owner-switch'
import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId
} from '../../shared/execution-host/execution-host'
import { pruneClosedOpenFileAcrossPartitions } from '../persistence/closed-open-file-partition-prune'
import type {
  WorkspaceSessionPatch,
  WorkspaceSessionState
} from '../../shared/workspace-session/workspace-session-state-types'
import {
  applyWorkspaceSessionEntriesPatch,
  storedDifferently,
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

  const relayApplier = registerDesktopRelayHandlers(store, isFenced)

  ipcMain.handle(
    'session:set',
    (
      _event,
      args: WorkspaceSessionState,
      hostId?: string | null,
      options?: WindowSessionSetOptions
    ): WorkspaceSessionSetResult => {
      if (isFenced(hostId)) {
        return { status: 'skipped' }
      }
      const stored = store.getWorkspaceSession(hostId)
      const save = windowSaveKeepingRelayOwnership(stored, args, 'set', options)
      const next = ORCA_LAYOUT_OWNER_IS_MAIN
        ? sessionForMain(save, hostId)
        : windowSaveKeepingMainSleepRecords(stored, save, 'set')
      // Main-owned layout recomputes relay ids itself; the window never sends them separately there.
      const relays = ORCA_LAYOUT_OWNER_IS_MAIN
        ? null
        : parseCarriedDesktopRelays(options?.carried, hostId)
      const relayHostId = normalizeExecutionHostId(hostId) ?? LOCAL_EXECUTION_HOST_ID
      const applied = relays ? relayApplier([relayHostId])(relayHostId, relays, next) : null
      // One publish for the snapshot and the relay ids that ride with it.
      store.setWorkspaceSession({ ...next, ...applied?.patch }, hostId)
      applied?.stored()
      const status = carriedRelayStatus(applied)
      return status ? { status: 'applied', relays: status } : { status: 'applied' }
    }
  )

  /** `relays`: the window's relay ids for this partition, applied by ownership in the same publish. */
  const patchWindowSession = (
    toPatch: (stored: WorkspaceSessionState) => WorkspaceSessionPatch,
    hostId: string | null | undefined,
    entries?: WorkspaceSessionEntriesPatch,
    relays?: DesktopRelayHostWrite | null
  ): Omit<WorkspaceSessionEntriesPatchResult, 'normalizedFields'> => {
    if (isFenced(hostId)) {
      return { status: 'skipped' }
    }
    const stored = store.getWorkspaceSession(hostId)
    const args = windowSaveKeepingRelayOwnership(stored, toPatch(stored), 'patch')
    const { save, written } = ORCA_LAYOUT_OWNER_IS_MAIN
      ? patchForMain(args, hostId, entries)
      : { save: windowSaveKeepingMainSleepRecords(stored, args, 'patch'), written: undefined }
    // Main-owned layout recomputes relay ids itself; the window never sends them separately there.
    const relayHostId = normalizeExecutionHostId(hostId) ?? LOCAL_EXECUTION_HOST_ID
    const applied =
      relays && !ORCA_LAYOUT_OWNER_IS_MAIN
        ? relayApplier([relayHostId])(relayHostId, relays, { ...stored, ...save })
        : null
    const relayStatus = carriedRelayStatus(applied)
    const withRelays = relayStatus ? { relays: relayStatus } : {}
    if (!ORCA_LAYOUT_OWNER_IS_MAIN && isNoopWindowSessionPatch(stored, save)) {
      if (applied?.patch) {
        store.patchWorkspaceSessionRelays(applied.patch, hostId, applied.changedTabIds)
        applied.stored()
        return { status: 'applied', ...withRelays }
      }
      noteWindowSessionSaveUnchanged(hostId)
      return { status: 'unchanged', ...withRelays }
    }
    // One publish for the entries and the relay ids that ride with them.
    store.patchWorkspaceSession({ ...save, ...applied?.patch }, hostId, written)
    applied?.stored()
    return { status: 'applied', ...withRelays }
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
      hostId?: string | null,
      relays?: unknown
    ): WorkspaceSessionEntriesPatchResult => {
      const result = patchWindowSession(
        (stored) => applyWorkspaceSessionEntriesPatch(stored, args),
        hostId,
        args,
        parseCarriedDesktopRelays(relays, hostId)
      )
      if (result.status === 'skipped') {
        return result
      }
      // Normalization, fences and main's sleep records can store something else, saved or not.
      const differ = storedDifferently(store.getWorkspaceSession(hostId), args)
      return {
        ...result,
        ...(differ.fields.length > 0 ? { normalizedFields: differ.fields } : {}),
        ...(Object.keys(differ.entries).length > 0 ? { normalizedEntries: differ.entries } : {})
      }
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

  // A closed editor file must not survive in superseded partitions; their stale open-file rows
  // re-materialize the tab at the next hydration (#42761). One main-side call keeps each
  // read-and-remove atomic against concurrent closes from any window.
  ipcMain.handle(
    'session:prune-closed-open-file',
    (_event, args: { worktreeId?: unknown; filePath?: unknown } | undefined) => {
      if (typeof args?.worktreeId !== 'string' || typeof args?.filePath !== 'string') {
        return
      }
      pruneClosedOpenFileAcrossPartitions(
        {
          // Mirror session:list-host-ids visibility: migration-hidden partitions are not user state.
          hostIds: [
            LOCAL_EXECUTION_HOST_ID,
            ...visibleSessionHostIds(store, store.getWorkspaceSessionHostIds()).filter(
              (hostId) => hostId !== LOCAL_EXECUTION_HOST_ID
            )
          ],
          read: (hostId) => store.getWorkspaceSession(hostId),
          write: (slice, hostId) => {
            if (!isFenced(hostId)) {
              store.setWorkspaceSession(slice, hostId)
            }
          }
        },
        { worktreeId: args.worktreeId, filePath: args.filePath }
      )
    }
  )

  ipcMain.handle(
    'session:read-terminal-scrollback',
    (_event, args: { ref?: unknown } | undefined) =>
      typeof args?.ref === 'string' ? store.readTerminalScrollbackSnapshotAsync(args.ref) : null
  )
}
