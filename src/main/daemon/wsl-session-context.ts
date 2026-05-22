import { splitWorktreeId } from '../../shared/worktree-id'
import { parseWslPath } from '../wsl'
import { parsePtySessionId } from './pty-session-id'

export type WslSessionContext = {
  distro: string
}

export function getWslContextFromSessionId(sessionId: string): WslSessionContext | undefined {
  const worktreeId = parsePtySessionId(sessionId).worktreeId
  const worktreePath = worktreeId ? splitWorktreeId(worktreeId)?.worktreePath : undefined
  const wslInfo = worktreePath ? parseWslPath(worktreePath) : null
  return wslInfo ? { distro: wslInfo.distro } : undefined
}
