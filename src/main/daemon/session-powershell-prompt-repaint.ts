import { isPowerShellProcess } from '../../shared/shell-process-detection'
import type { SubprocessHandle } from './session-subprocess-handle'

export type PowerShellPromptRepaintDeps = {
  subprocess: Pick<SubprocessHandle, 'getForegroundProcess' | 'write'>
  /** True while the shell-ready barrier still queues stdin. */
  isGatingWrites: boolean
  isCursorOnEmptyPromptLine(): boolean
}

/** Why: ConPTY's buffer clear leaves PSReadLine's cached cursor row stale, so the next prompt
 *  repaints below a blank gap; a form feed (Ctrl+L) forces a repaint at the true origin. Gated to a
 *  PowerShell foreground (else a running command/TUI gets a stray 0x0C) and an empty prompt (PSReadLine
 *  repaints pending input at a stale cached row ConPTY's fixed viewport doesn't track). */
export function nudgePowerShellPromptRepaint(deps: PowerShellPromptRepaintDeps): void {
  if (process.platform !== 'win32') {
    return
  }
  // Why: before shell-ready, write() would queue this form feed behind the startup command and
  // fire it later when the gates below are stale; the nudge is cosmetic, so skip rather than defer.
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
