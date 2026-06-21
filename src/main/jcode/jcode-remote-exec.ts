// brain-local / hands-remote (M3) host resolution for a jcode chat turn.
// A jcode chat opened in ANY connectionId-remote workspace implies remote
// execution: jcode itself runs LOCALLY (local auth/model) but its bash/read tools
// execute on the remote host via `--remote-exec <host>`. We therefore emit
// --remote-exec whenever the workspace is bound to an SSH connection — not only
// when the user manually toggled `isRemoteExecOnly`. (The folderPath / worktree
// path of such a workspace is a REMOTE path that does not exist on the Mac, so
// running fully local would both crash the spawn and execute bash against a
// nonexistent local dir.)
import type { Store } from '../persistence'
import { parseWorkspaceKey } from '../../shared/workspace-scope'
import { getRepoIdFromWorktreeId, splitWorktreeIdForFilesystem } from '../../shared/worktree-id'
import type { JcodeChatSendPayload } from '../../shared/jcode-chat-types'
import type { RemoteExecResolution } from './jcode-attachments'

/** Resolve the SSH host string for a connection, preferring the OpenSSH config
 *  alias so ~/.ssh/config (ProxyJump/identity) applies; falls back to the raw
 *  host. jcode resolves the host itself. Returns null when no usable host. */
function resolveSshHost(store: Store, connectionId: string): string | null {
  const target = store.getSshTarget(connectionId)
  return target?.configHost?.trim() || target?.host?.trim() || null
}

/** Resolve the SSH connectionId + remote working dir for the workspace this chat
 *  turn is bound to, or null when it is local / unresolvable. Handles both shapes
 *  flowing through `payload.worktreeId`:
 *   - FOLDER workspaces — id is a `folder:<id>` workspace key; remote path is the
 *     FolderWorkspace.folderPath.
 *   - GIT worktrees (project "类型: Git") — id is the RAW `${repoId}::${path}`
 *     worktree id (NOT `worktree:`-prefixed). The connectionId lives on the owning
 *     Repo; the worktree's path segment IS the remote working dir. Without this
 *     branch a remote git project resolved host=null and the turn ran LOCAL with
 *     cwd = the remote path → `spawn ... ENOENT`. */
function resolveWorkspaceConnection(
  store: Store,
  worktreeId: string,
  payloadCwd: string | undefined
): { connectionId: string; remotePath: string | null } | null {
  const scope = parseWorkspaceKey(worktreeId)
  if (scope?.type === 'folder') {
    const workspace = store.getFolderWorkspace(scope.folderWorkspaceId)
    return workspace?.connectionId
      ? { connectionId: workspace.connectionId, remotePath: workspace.folderPath?.trim() || null }
      : null
  }
  const rawWorktreeId = scope?.type === 'worktree' ? scope.worktreeId : worktreeId
  const repoId = getRepoIdFromWorktreeId(rawWorktreeId)
  const repo = repoId ? store.getRepo(repoId) : undefined
  if (!repo?.connectionId) {
    return null
  }
  // payloadCwd carries the worktree's remote path from the renderer; the
  // worktree-id path segment is the authoritative fallback.
  const remotePath =
    splitWorktreeIdForFilesystem(rawWorktreeId)?.worktreePath?.trim() || payloadCwd?.trim() || null
  return { connectionId: repo.connectionId, remotePath }
}

/** Resolve the brain-local remote-exec target for a chat turn. Returns host null
 *  (and connectionId/remotePath null) when the turn should run fully local.
 *  Falls back to the explicit `payload.remoteExecHost` override. */
export function resolveRemoteExec(
  store: Store | undefined,
  payload: JcodeChatSendPayload
): RemoteExecResolution {
  const bound =
    store && typeof payload.worktreeId === 'string' && payload.worktreeId.length > 0
      ? resolveWorkspaceConnection(store, payload.worktreeId, payload.cwd)
      : null
  if (bound) {
    const host = resolveSshHost(store!, bound.connectionId)
    if (host) {
      return { host, connectionId: bound.connectionId, remotePath: bound.remotePath }
    }
  }
  return { host: payload.remoteExecHost?.trim() || null, connectionId: null, remotePath: null }
}
