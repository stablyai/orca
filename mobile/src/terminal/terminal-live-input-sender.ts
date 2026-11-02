export type TerminalLiveInputSender = (
  handle: string,
  bytes: string,
  origin?: 'pointer'
) => Promise<boolean>
