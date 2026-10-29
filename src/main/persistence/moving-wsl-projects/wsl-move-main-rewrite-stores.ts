/**
 * The main-process stores a committed WSL move rewrites, in run order: the persisted UI's
 * routing, the local session's focus, then the host partition's seed. Each re-reads the profile,
 * so a run after a crash before its ledger entry finds its own earlier write and changes nothing.
 */
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type { WslMoveCutover } from '../../../shared/wsl-move/wsl-move-cutover'
import type {
  WorkspaceSessionPatch,
  WorkspaceSessionState
} from '../../../shared/workspace-session-state-types'
import type { Store } from '../loading-store/store'
import { wslMoveAutomationHostFilterUpdate } from './wsl-move-automation-filter-rewrite'
import { registerWslMoveDesktopRewriteStore } from './wsl-move-desktop-rewrite-stores'
import { wslMoveRewriteScope, type WslMoveRewriteScope } from './wsl-move-rewrite-scope'
import { withWslMoveSeededViewState } from './wsl-move-seeded-view-state'
import { wslMoveHostSessionSeed, wslMoveSessionGlobalsPatch } from './wsl-move-session-rewrite'
import { rewriteWslMoveUiRouting } from './wsl-move-ui-routing-rewrite'
import { holdWslMoveWindowWrites } from './wsl-move-window-write-hold'

export type WslMoveMainRewriteProfile = Pick<
  Store,
  | 'getUI'
  | 'updateUI'
  | 'getWorkspaceSession'
  | 'patchWorkspaceSession'
  | 'setWorkspaceSession'
  | 'flushPendingOrThrowAsync'
>

/**
 * Each of these rewrites state an open window also saves, so it first holds that window's saves;
 * the pass reloads the window once they are on disk (wsl-move-window-write-hold.ts).
 */
export function registerWslMoveMainRewriteStores(profile: WslMoveMainRewriteProfile): void {
  // Resolves once this pass's writes are on disk, not merely scheduled.
  const flush = (): Promise<void> => profile.flushPendingOrThrowAsync()
  registerWslMoveDesktopRewriteStore({
    id: 'ui-routing',
    side: 'main',
    run: (context) => {
      holdWslMoveWindowWrites()
      const ui = profile.getUI()
      const automationHostFilter = wslMoveAutomationHostFilterUpdate(
        ui.automationHostFilter,
        context.cutover.manifest.payload.dormantState?.automations?.length ?? 0
      )
      const updates = {
        ...rewriteWslMoveUiRouting(ui, wslMoveRewriteScope(context)),
        ...(automationHostFilter ? { automationHostFilter } : {})
      }
      if (Object.keys(updates).length > 0) {
        profile.updateUI(updates)
      }
    },
    flush
  })
  registerWslMoveDesktopRewriteStore({
    id: 'session-globals',
    side: 'main',
    run: (context) => {
      holdWslMoveWindowWrites()
      applyWslMoveSessionFocus(profile, wslMoveRewriteScope(context))
    },
    flush
  })
  registerWslMoveDesktopRewriteStore({
    id: 'host-session-seed',
    side: 'main',
    run: (context) => {
      holdWslMoveWindowWrites()
      const seeded = applyWslMoveHostSessionSeed(
        profile,
        context.cutover,
        wslMoveRewriteScope(context),
        new Set(context.cutover.seededHostWorkspaceIds)
      )
      if (seeded.length > 0) {
        // Recorded before the flush: a crash may then lose the seed, but never revives a closed tab.
        context.recordSeededHostWorkspaceIds(seeded)
      }
    },
    flush
  })
}

/**
 * The local session's focus onto the host when it names a moved project, or (undo, given
 * wslMoveReleasedSessionFocusPatch) back here from a released one; true when it wrote.
 */
export function applyWslMoveSessionFocus(
  profile: Pick<Store, 'getWorkspaceSession' | 'patchWorkspaceSession'>,
  scope: WslMoveRewriteScope,
  focusPatch: (
    session: WorkspaceSessionState,
    scope: WslMoveRewriteScope
  ) => WorkspaceSessionPatch | null = wslMoveSessionGlobalsPatch
): boolean {
  const patch = focusPatch(profile.getWorkspaceSession(LOCAL_EXECUTION_HOST_ID), scope)
  if (!patch) {
    return false
  }
  // A move's (or its undo's) one-shot rewrite of focus; no LayoutCommand owns focus.
  profile.patchWorkspaceSession(patch, LOCAL_EXECUTION_HOST_ID)
  return true
}

/** Seeds the host partition with the carried rows of moved workspaces it lacks; returns their ids. */
export function applyWslMoveHostSessionSeed(
  profile: Pick<Store, 'getWorkspaceSession' | 'setWorkspaceSession'>,
  cutover: Pick<WslMoveCutover, 'manifest' | 'destinationEnvironmentId'>,
  scope: WslMoveRewriteScope,
  alreadySeeded: ReadonlySet<string>
): string[] {
  const carried = cutover.manifest.payload.dormantState?.workspaceSession
  if (!carried) {
    return []
  }
  const hostId = scope.destinationHostId
  const existing = profile.getWorkspaceSession(hostId)
  const seed = wslMoveHostSessionSeed(carried, existing, scope, alreadySeeded)
  if (!seed) {
    return []
  }
  const seededIds = new Set(seed.workspaceIds)
  const next =
    withWslMoveSeededViewState(
      seed.session,
      profile.getWorkspaceSession(LOCAL_EXECUTION_HOST_ID),
      { ...scope, destinationEnvironmentId: cutover.destinationEnvironmentId },
      seededIds
    ) ?? seed.session
  // A move's one-shot seed; layout commands refuse runtime hosts.
  profile.setWorkspaceSession(next, hostId)
  return [...seededIds]
}
