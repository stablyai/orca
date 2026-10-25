import { getRegisteredSshState } from '../../../ssh/targets/ssh-target-registry'
import { splitWorktreeIdForFilesystem } from '../../../../shared/worktree/id'
import { isWindowsAbsolutePathLike } from '../../../../shared/cross-platform-path'
import type { RuntimePtyWorktreeRecord } from '../../runtime-terminal-state-records'

/** Platform of the host whose pty transport ingests our writes -- deliberately NOT the OS
 *  the command runs under. A WSL pane is spawned as `wsl.exe` through the Windows ConPTY
 *  (see local-pty-provider), so it pays the ConPTY ingest cost even though its shell is
 *  Linux; an SSH pane is spawned by node-pty on the remote host, so the client's
 *  process.platform says nothing about it. */
export function resolvePtyWriteHostPlatform(
  pty: Pick<RuntimePtyWorktreeRecord, 'connectionId' | 'worktreeId'> | undefined
): NodeJS.Platform {
  const connectionId = pty?.connectionId
  if (!connectionId) {
    return process.platform
  }
  const remotePlatform = getRegisteredSshState(connectionId)?.remotePlatform
  if (remotePlatform) {
    return remotePlatform
  }
  // Why: remotePlatform only arrives with the relay handshake; until then the worktree path
  // flavor is the same signal getAgentLaunchPlatformForRepo already trusts for a remote repo.
  const worktreePath = pty ? splitWorktreeIdForFilesystem(pty.worktreeId)?.worktreePath : null
  return worktreePath && isWindowsAbsolutePathLike(worktreePath) ? 'win32' : 'linux'
}
