import { splitWorktreeIdForFilesystem } from '../../shared/worktree-id'
import { parseWslPath } from '../wsl'
import { parsePtySessionId } from './pty-session-id'

export type WslSessionContext = {
  distro: string
  treatPosixCwdAsWsl: true
}

export function getWslContextFromSessionId(sessionId: string): WslSessionContext | undefined {
  const worktreeId = parsePtySessionId(sessionId).worktreeId
  const worktreePath = worktreeId
    ? splitWorktreeIdForFilesystem(worktreeId)?.worktreePath
    : undefined
  const wslInfo = worktreePath ? parseWslPath(worktreePath) : null
  return wslInfo ? { distro: wslInfo.distro, treatPosixCwdAsWsl: true } : undefined
}
