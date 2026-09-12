import type { MultiplexerTransportWriteResult } from './ssh-multiplexer-write-settlement'

export type MultiplexerTransport = {
  /** Local channel identity only; never serialized onto the relay wire. */
  sourceChannel?: object
  write: (
    data: Buffer,
    onSettled?: (result: MultiplexerTransportWriteResult) => void
  ) => boolean | void
  onData: (cb: (data: Buffer) => void) => void
  onClose: (cb: () => void) => void
  onDrain?: (cb: () => void) => void | (() => void)
  supportsWriteSettlement?: boolean
  pauseReads?: () => void
  resumeReads?: () => void
  close?: () => void
}
