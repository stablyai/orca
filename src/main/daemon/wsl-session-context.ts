import { splitWorktreeIdForFilesystem } from '../../shared/worktree-id'
import { isWslShellName } from '../../shared/local-windows-terminal-runtime'
import { parseWslPath } from '../wsl'
import { parsePtySessionId } from './pty-session-id'
import { parseWslUncPath } from '../../shared/wsl-paths'

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

export function getWslContextFromPreferredDistro(
  distro: string | null | undefined
): WslSessionContext | undefined {
  const trimmed = distro?.trim()
  return trimmed ? { distro: trimmed, treatPosixCwdAsWsl: true } : undefined
}

export function resolveWslSessionContext(args: {
  cwd?: string
  sessionId?: string
  shellOverride?: string
  terminalWindowsWslDistro?: string | null
}): WslSessionContext | undefined {
  if (process.platform !== 'win32') {
    return undefined
  }
  const cwdDistro = args.cwd ? parseWslUncPath(args.cwd)?.distro : undefined
  if (cwdDistro) {
    return { distro: cwdDistro, treatPosixCwdAsWsl: true }
  }
  return (
    (args.sessionId ? getWslContextFromSessionId(args.sessionId) : undefined) ??
    (isWslShellName(args.shellOverride)
      ? getWslContextFromPreferredDistro(args.terminalWindowsWslDistro)
      : undefined)
  )
}
