import { win32 as pathWin32 } from 'node:path'
import { isTerminalScopeWrapper } from '../terminal-scopes-runtime'

function normalizeForegroundProcessName(processName: string | null | undefined): string | null {
  const trimmed = processName?.trim().replace(/^["']|["']$/g, '') ?? ''
  if (!trimmed || trimmed === 'xterm-256color') {
    return null
  }
  return trimmed.split(/[\\/]/).pop() || null
}

/** ConPTY can report no usable name; only Windows falls back to the spawned shell. */
export function resolveFallbackForegroundProcess(
  processName: string | null | undefined,
  shellPath: string
): string | null {
  // node-pty can report Orca’s scope wrapper during exec or after the foreground leader exits.
  const normalized = normalizeForegroundProcessName(
    processName && isTerminalScopeWrapper(processName.trim()) ? shellPath : processName
  )
  if (normalized || process.platform !== 'win32') {
    return normalized
  }
  return normalizeForegroundProcessName(pathWin32.basename(shellPath))
}
