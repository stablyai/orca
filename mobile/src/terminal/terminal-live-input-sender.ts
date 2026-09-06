export type TerminalLiveInputSender = {
  (handle: string, bytes: string): Promise<boolean>
  cancelPending?: (handle: string) => void
  supportsPipeline?: (handle: string) => boolean
  captureFailureReporter?: (handle: string) => () => void
}
export type TerminalLiveExternalSend = (
  handle: string,
  send?: TerminalLiveExternalAction,
  retainedText?: string
) => Promise<boolean>
export type TerminalLiveControlQueue = (
  handle: string,
  bytes: string,
  send?: TerminalLiveExternalAction
) => Promise<boolean>
// Only a callback that has not dispatched input may return cancelled.
export type TerminalLiveDispatchResult = boolean | 'cancelled'
export type TerminalLiveExternalAction = (
  isCurrent: () => boolean
) => Promise<TerminalLiveDispatchResult>
