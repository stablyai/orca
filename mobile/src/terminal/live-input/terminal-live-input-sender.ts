import type { TerminalInputEnqueueOptions } from '../input-delivery/mobile-terminal-input-owner'

export type TerminalLiveInputSender = (
  handle: string,
  bytes: string,
  origin?: 'pointer',
  enqueue?: TerminalInputEnqueueOptions
) => Promise<boolean>
