import { getRegisteredSshState } from '../../../ssh/targets/ssh-target-registry'
import { splitWorktreeIdForFilesystem } from '../../../../shared/worktree/id'
import { isWindowsAbsolutePathLike } from '../../../../shared/cross-platform-path'
import type { RuntimePtyWorktreeRecord } from '../../runtime-terminal-state-records'

/** Use the PTY transport host: WSL ingests through Windows ConPTY, while SSH uses remote node-pty. */
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
  // Before the relay handshake, trust the worktree path flavor, as getAgentLaunchPlatformForRepo does.
  const worktreePath = pty ? splitWorktreeIdForFilesystem(pty.worktreeId)?.worktreePath : null
  return worktreePath && isWindowsAbsolutePathLike(worktreePath) ? 'win32' : 'linux'
}
