import type { TerminalInputEnqueueOptions } from './mobile-terminal-input-sender'

export type TerminalLiveInputSender = (
  handle: string,
  bytes: string,
  origin?: 'pointer',
  enqueue?: TerminalInputEnqueueOptions
) => Promise<boolean>
