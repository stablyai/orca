import type { ExecutionHostId } from '../../shared/execution-host'
import type { RuntimeStore } from './runtime-store-contract'
import { resolveWorktreeRemovalMetadata } from '../worktree-removal-repo-owner'

export function assertRuntimeWorktreeRemovalInstance(params: {
  store: RuntimeStore
  repoId: string
  worktreeId: string
  hostId: ExecutionHostId
  expectedInstanceId?: string
}): void {
  if (!params.expectedInstanceId) {
    return
  }
  const meta = resolveWorktreeRemovalMetadata(
    params.store,
    params.repoId,
    params.worktreeId,
    params.hostId
  )
  if (meta?.instanceId !== params.expectedInstanceId) {
    throw new Error('Checkout instance identity changed before worktree removal.')
  }
}
