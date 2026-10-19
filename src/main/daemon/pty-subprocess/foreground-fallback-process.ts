import { win32 as pathWin32 } from 'node:path'
import { isTerminalScopeWrapper } from '../terminal-scopes-runtime'

function normalizeForegroundProcessName(processName: string | null | undefined): string | null {
  const trimmed = processName?.trim().replace(/^["']|["']$/g, '') ?? ''
  if (!trimmed || trimmed === 'xterm-256color') {
    return null
  }
  return trimmed.split(/[\\/]/).pop() || null
}

/**
 * node-pty's reported foreground name, normalized to a bare executable.
 * Windows ConPTY can report nothing useful; fall back to the spawned shell.
 */
export function resolveFallbackForegroundProcess(
  processName: string | null | undefined,
  shellPath: string
): string | null {
  // Why: node-pty names Orca's exact wrapper path while it execs the shell, and as its spawn file
  // once the foreground group's leader has exited (`true | claude`); both mean the shell.
  const normalized = normalizeForegroundProcessName(
    processName && isTerminalScopeWrapper(processName.trim()) ? shellPath : processName
  )
  if (normalized || process.platform !== 'win32') {
    return normalized
  }
  return normalizeForegroundProcessName(pathWin32.basename(shellPath))
}
