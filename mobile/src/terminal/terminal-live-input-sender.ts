export type TerminalLiveInputSender = {
  (handle: string, bytes: string): Promise<boolean>
  cancelPending?: (handle: string) => void
  supportsPipeline?: (handle: string) => boolean
}
