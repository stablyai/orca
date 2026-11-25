import { win32 as pathWin32 } from 'node:path'
import { isTerminalScopeWrapper } from '../process-scopes/terminal-scopes-runtime'
import { isShellProcess } from '../../../shared/agent-status/process/shell-process-detection'
import { isAgentForegroundWrapperProcess } from '../../../shared/agent-status/process/agent-process-recognition'
import { shouldInspectOuterWrapperForegroundName } from '../../../shared/agent-status/process/foreground-wrapper-agent'

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

/** Whether a raw foreground name may hide an agent worth a process-table lookup. */
export function shouldInspectForegroundFallback(fallbackProcess: string | null): boolean {
  return (
    fallbackProcess !== null &&
    (isShellProcess(fallbackProcess) ||
      isAgentForegroundWrapperProcess(fallbackProcess) ||
      shouldInspectOuterWrapperForegroundName(fallbackProcess) ||
      process.platform !== 'win32')
  )
}
