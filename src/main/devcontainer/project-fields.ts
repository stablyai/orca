/**
 * Maps a discovered devcontainer to the repo/project fields Add-Project must
 * persist. This is the single place the hybrid model is encoded:
 *  - `path` is the HOST bind-mount folder, so Orca's local filesystem/git
 *    providers operate on the same inodes the container sees.
 *  - `executionHostId`/`connectionId` are the devcontainer host id, so the PTY
 *    routes to the docker provider (terminal runs in the container).
 *  - `worktreeBasePath` is relative (inside the mount) and worktrees are created
 *    with relative gitdir pointers, so they're valid from both host and
 *    container paths (see Phase 3).
 */
import { toDevcontainerExecutionHostId } from '../../shared/execution-host'
import { DEVCONTAINER_WORKTREE_BASE_PATH } from '../../shared/devcontainer-types'
import type { DevcontainerInfo } from './discovery'

export { DEVCONTAINER_WORKTREE_BASE_PATH }

export type DevcontainerProjectFields = {
  path: string
  displayName: string
  executionHostId: `devcontainer:${string}`
  connectionId: string
  worktreeBasePath: string
  relativePaths: true
}

/** Map a discovered devcontainer to the repo/project fields Add-Project persists. */
export function buildDevcontainerProjectFields(
  info: Pick<DevcontainerInfo, 'hostFolder'>
): DevcontainerProjectFields {
  const hostId = toDevcontainerExecutionHostId(info.hostFolder)
  return {
    path: info.hostFolder,
    displayName: info.hostFolder.split('/').filter(Boolean).pop() ?? info.hostFolder,
    executionHostId: hostId,
    // Route the PTY by the same id the provider is registered under.
    connectionId: hostId,
    worktreeBasePath: DEVCONTAINER_WORKTREE_BASE_PATH,
    relativePaths: true
  }
}
