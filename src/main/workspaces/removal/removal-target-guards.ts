import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../shared/execution-host/execution-host'
import {
  assertWslMoveWorkspaceWritable,
  isWslMoveSourceHost
} from '../../persistence/moving-wsl-projects/quiescence/wsl-move-scope-guard'
import type { RuntimeStore } from '../../runtime/construction/runtime-store-contract'
import type { RuntimeWorktreeRemovalTarget } from '../../runtime/workspaces/catalog/runtime-worktree-selection'
import { resolveWorktreeRemovalMetadata } from './worktree-removal-repo-owner'
import { assertWorktreeNotProviderManaged } from './provider-worktree-removal-guard'

/** Refusals shared by every entry point that can delete a checkout. */
export function assertWorktreeRemovalTargetAllowed(
  store: RuntimeStore,
  target: Pick<RuntimeWorktreeRemovalTarget, 'id' | 'repoId'>,
  fenceHostId: ExecutionHostId | undefined
): void {
  assertWorktreeNotProviderManaged(
    target.id,
    resolveWorktreeRemovalMetadata(
      store,
      target.repoId,
      target.id,
      fenceHostId ?? LOCAL_EXECUTION_HOST_ID
    )
  )
  if (isWslMoveSourceHost(fenceHostId)) {
    assertWslMoveWorkspaceWritable(store, target.id)
  }
}
