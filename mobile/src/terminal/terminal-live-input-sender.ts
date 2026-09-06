export type TerminalLiveInputSender = {
  (handle: string, bytes: string): Promise<boolean>
  cancelPending?: (handle: string) => void
  supportsPipeline?: (handle: string) => boolean
  captureFailureReporter?: (handle: string) => () => void
}
export type TerminalLiveExternalSend = (
  handle: string,
  send?: TerminalLiveExternalAction,
  retainedText?: string,
  options?: TerminalLiveControlOptions
) => Promise<boolean>
export type TerminalLiveControlQueue = (
  handle: string,
  bytes: string,
  send?: TerminalLiveExternalAction,
  options?: TerminalLiveControlOptions
) => Promise<boolean>
export type TerminalLiveControlOptions = {
  readonly fieldBoundary?: import('./terminal-live-hardware-key-mapping').TerminalLiveHardwareKeyEvent['fieldBoundary']
  readonly nativeFieldReset?: boolean
  readonly onAdmitted?: () => void
  readonly reservedBytes?: number
}
// Only a callback that has not dispatched input may return cancelled.
export type TerminalLiveDispatchResult = boolean | 'cancelled'
export type TerminalLiveExternalAction = (
  isCurrent: () => boolean
) => Promise<TerminalLiveDispatchResult>
