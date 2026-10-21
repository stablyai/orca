/**
 * The main-process stores a committed WSL move rewrites (D1b-7c), in run order: the persisted UI's
 * routing, the local session's focus, then the host partition's seed. Each re-reads the profile,
 * so a run after a crash before its ledger entry finds its own earlier write and changes nothing.
 */
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type { Store } from '../loading-store/store'
import { registerWslMoveDesktopRewriteStore } from './wsl-move-desktop-rewrite-stores'
import { wslMoveRewriteScope } from './wsl-move-rewrite-scope'
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

export function registerWslMoveMainRewriteStores(profile: WslMoveMainRewriteProfile): void {
  // Resolves once this pass's writes are on disk, not merely scheduled.
  const flush = (): Promise<void> => profile.flushPendingOrThrowAsync()
  registerWslMoveDesktopRewriteStore({
    id: 'ui-routing',
    side: 'main',
    run: (context) => {
      const updates = rewriteWslMoveUiRouting(profile.getUI(), wslMoveRewriteScope(context))
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
      const patch = wslMoveSessionGlobalsPatch(
        profile.getWorkspaceSession(LOCAL_EXECUTION_HOST_ID),
        wslMoveRewriteScope(context)
      )
      if (patch) {
        // One-shot, ledgered move rewrite of focus; no LayoutCommand owns focus or seeding.
        profile.patchWorkspaceSession(patch, LOCAL_EXECUTION_HOST_ID)
      }
    },
    flush
  })
  registerWslMoveDesktopRewriteStore({
    id: 'host-session-seed',
    side: 'main',
    run: (context) => {
      const carried = context.cutover.manifest.payload.dormantState?.workspaceSession
      if (!carried) {
        return
      }
      const hostId = context.destinationHostId
      const seed = wslMoveHostSessionSeed(
        carried,
        profile.getWorkspaceSession(hostId),
        wslMoveRewriteScope(context),
        new Set(context.cutover.seededHostWorkspaceIds)
      )
      if (seed) {
        // One-shot, ledgered move rewrite; layout commands refuse runtime hosts' partitions.
        profile.setWorkspaceSession(seed.session, hostId)
        // Recorded before the flush: a crash may then lose the seed, but never revives a closed tab.
        context.recordSeededHostWorkspaceIds(seed.workspaceIds)
      }
    },
    flush
  })
}
