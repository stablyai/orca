import {
  encodeTerminalStreamFrame,
  type TerminalStreamOpcode
} from '../../../../../shared/terminal-stream-protocol'

export function createLegacyTerminalFrameSender(options: {
  streamId: number
  isClosed: () => boolean
  sendBinary: (bytes: Uint8Array<ArrayBufferLike>) => boolean | void
  closeOnFailure?: () => void
}) {
  let cursor = 0
  return (
    opcode: TerminalStreamOpcode,
    payload: Uint8Array<ArrayBufferLike> = new Uint8Array(),
    frameSeq = cursor++
  ): void => {
    if (options.isClosed()) {
      return
    }
    const bytes = encodeTerminalStreamFrame({
      opcode,
      streamId: options.streamId,
      seq: frameSeq,
      payload
    })
    if (!options.closeOnFailure) {
      options.sendBinary(bytes)
      return
    }
    try {
      if (options.sendBinary(bytes) === false) {
        options.closeOnFailure()
      }
    } catch {
      options.closeOnFailure()
    }
  }
}
