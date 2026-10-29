import { isPowerShellProcess } from '../../shared/shell-process-detection'
import type { SubprocessHandle } from './session-subprocess-handle'

export type PowerShellPromptRepaintDeps = {
  subprocess: Pick<SubprocessHandle, 'getForegroundProcess' | 'write'>
  isGatingWrites: boolean
  isCursorOnEmptyPromptLine(): boolean
}

/** Ctrl+L fixes PSReadLine’s cached row after a ConPTY clear; send only to an empty PowerShell prompt. */
export function nudgePowerShellPromptRepaint(deps: PowerShellPromptRepaintDeps): void {
  if (process.platform !== 'win32') {
    return
  }
  // Skip before readiness: a queued repaint could arrive after the checked prompt state changes.
  if (deps.isGatingWrites) {
    return
  }
  if (!isPowerShellProcess(deps.subprocess.getForegroundProcess())) {
    return
  }
  if (!deps.isCursorOnEmptyPromptLine()) {
    return
  }
  deps.subprocess.write('\x0c')
}
