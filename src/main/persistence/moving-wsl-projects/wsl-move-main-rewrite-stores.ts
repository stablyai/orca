/**
 * The main-process stores a committed WSL move rewrites (D1b-7c), in run order: the persisted UI's
 * routing, the local session's focus, then the host partition's seed. Each re-reads the profile,
 * so a run after a crash before its ledger entry finds its own earlier write and changes nothing.
 */
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type { WslMoveCutover } from '../../../shared/wsl-move/wsl-move-cutover'
import type { Store } from '../loading-store/store'
import { wslMoveAutomationHostFilterUpdate } from './wsl-move-automation-filter-rewrite'
import { registerWslMoveDesktopRewriteStore } from './wsl-move-desktop-rewrite-stores'
import { wslMoveRewriteScope, type WslMoveRewriteScope } from './wsl-move-rewrite-scope'
import { withWslMoveSeededViewState } from './wsl-move-seeded-view-state'
import { wslMoveHostSessionSeed, wslMoveSessionGlobalsPatch } from './wsl-move-session-rewrite'
import { rewriteWslMoveUiRouting } from './wsl-move-ui-routing-rewrite'

export type WslMoveMainRewriteProfile = Pick<
  Store,
  | 'getUI'
  | 'updateUI'
  | 'getWorkspaceSession'
  | 'patchWorkspaceSession'
  | 'setWorkspaceSession'
  | 'flushPendingOrThrowAsync'
>

// Moves rewritten while a window was open: that window hydrated before them, so its unload
// re-applies them once (wsl-move-stale-window-reapply.ts).
const rewrittenUnderOpenWindow = new Set<string>()

/** Drains the moves rewritten under a window that is now unloading. */
export function takeWslMoveRewritesUnderOpenWindow(): string[] {
  const ids = [...rewrittenUnderOpenWindow]
  rewrittenUnderOpenWindow.clear()
  return ids
}

export function registerWslMoveMainRewriteStores(
  profile: WslMoveMainRewriteProfile,
  windowOpen: () => boolean = () => false
): void {
  // Resolves once this pass's writes are on disk, not merely scheduled.
  const flush = (): Promise<void> => profile.flushPendingOrThrowAsync()
  const noteOpenWindow = (migrationId: string): void => {
    if (windowOpen()) {
      rewrittenUnderOpenWindow.add(migrationId)
    }
  }
  registerWslMoveDesktopRewriteStore({
    id: 'ui-routing',
    side: 'main',
    run: (context) => {
      noteOpenWindow(context.cutover.migrationId)
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
      applyWslMoveSessionFocus(profile, wslMoveRewriteScope(context))
    },
    flush
  })
  registerWslMoveDesktopRewriteStore({
    id: 'host-session-seed',
    side: 'main',
    run: (context) => {
      noteOpenWindow(context.cutover.migrationId)
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

/** The local session's focus onto the host when it names a moved project; true when it wrote. */
export function applyWslMoveSessionFocus(
  profile: Pick<Store, 'getWorkspaceSession' | 'patchWorkspaceSession'>,
  scope: WslMoveRewriteScope
): boolean {
  const patch = wslMoveSessionGlobalsPatch(
    profile.getWorkspaceSession(LOCAL_EXECUTION_HOST_ID),
    scope
  )
  if (!patch) {
    return false
  }
  // A move's rewrite of focus, re-applied only to undo a stale window; no LayoutCommand owns focus.
  profile.patchWorkspaceSession(patch, LOCAL_EXECUTION_HOST_ID)
  return true
}

/** Seeds the host partition with the carried rows of moved workspaces it lacks; returns their ids. */
export function applyWslMoveHostSessionSeed(
  profile: Pick<Store, 'getWorkspaceSession' | 'setWorkspaceSession'>,
  cutover: Pick<WslMoveCutover, 'manifest' | 'destinationEnvironmentId'>,
  scope: WslMoveRewriteScope,
  alreadySeeded: ReadonlySet<string>,
  replaceEchoes = false
): string[] {
  const carried = cutover.manifest.payload.dormantState?.workspaceSession
  if (!carried) {
    return []
  }
  const hostId = scope.destinationHostId
  const seed = wslMoveHostSessionSeed(
    carried,
    profile.getWorkspaceSession(hostId),
    scope,
    alreadySeeded,
    replaceEchoes
  )
  if (!seed) {
    return []
  }
  const withViewState = withWslMoveSeededViewState(
    seed.session,
    profile.getWorkspaceSession(LOCAL_EXECUTION_HOST_ID),
    { ...scope, destinationEnvironmentId: cutover.destinationEnvironmentId },
    new Set(seed.workspaceIds)
  )
  // A move's one-shot seed, or its redo after a stale window; layout commands refuse runtime hosts.
  profile.setWorkspaceSession(withViewState ?? seed.session, hostId)
  return seed.workspaceIds
}
