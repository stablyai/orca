import { triggerError } from '../../platform/haptics'
import { terminalCreateCopy } from './mobile-session-terminal-create-copy'
import type { MobileSessionAttachmentsModel } from '../../files/attachments/use-mobile-session-attachments'
import type { MobileSessionTerminalCreateOptions } from './mobile-session-terminal-create-request'

export function createMobileSessionTerminalCreateFeedback(args: {
  sourceFork: MobileSessionTerminalCreateOptions['sourceChatFork']
  isCurrent: () => boolean
  setCreateError: MobileSessionAttachmentsModel['setCreateError']
  showToast: MobileSessionAttachmentsModel['showToast']
  options: MobileSessionTerminalCreateOptions | undefined
}) {
  const { sourceFork, isCurrent, setCreateError, showToast, options } = args

  const reportFork = (message: string): void => {
    if (!sourceFork || !isCurrent()) {
      return
    }
    setCreateError(message)
    triggerError()
    showToast(message, 3000)
  }

  // Surface host-specific create errors so users can distinguish exhausted PTYs, disabled agents and missing ownership.
  function reportCreateFailure(hostReason: string): void {
    if (!isCurrent()) {
      return
    }
    const reason = hostReason.trim() || options?.errorToast || terminalCreateCopy.createFailed()
    setCreateError(reason)
    // Only empty sessions show inline errors; existing tabs need toast feedback.
    triggerError()
    showToast(reason, 1800)
  }

  return { reportFork, reportCreateFailure }
}
