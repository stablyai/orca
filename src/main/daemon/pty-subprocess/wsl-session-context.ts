import { splitWorktreeIdForFilesystem } from '../../../shared/worktree/id'
import { selectEffectiveTerminalExecutionContext } from '../../../shared/terminal/effective-terminal-execution-context'
import { getDefaultWslDistro } from '../../wsl/discovery/distro-catalog'
import { parseWslPath } from '../../wsl/filesystem/unc-path-access'
import { parsePtySessionId } from '../../../shared/terminal/pty/lifecycle/pty-session-id-format'

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
  const inputs = {
    platform: process.platform,
    cwd: args.cwd,
    worktreeContext: args.sessionId ? getWslContextFromSessionId(args.sessionId) : undefined,
    shell: args.shellOverride,
    preferredDistro: args.terminalWindowsWslDistro
  }
  let selected = selectEffectiveTerminalExecutionContext(inputs)
  if (selected.kind === 'unresolved-wsl') {
    selected = selectEffectiveTerminalExecutionContext({
      ...inputs,
      defaultDistro: getDefaultWslDistro()
    })
  }
  return selected.kind === 'wsl' ? selected.context : undefined
}
