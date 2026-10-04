import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { readFileViaStream } from '../ssh/ssh-filesystem-stream-reader'
import type { FileReadLimits, FileReadResult } from './filesystem-provider-contract'

export async function readSshDecodedDshLog(
  mux: SshChannelMultiplexer,
  filePath: string
): Promise<FileReadResult> {
  const result = await mux.request('fs.readFile', { filePath, decodeDshHistory: true })
  if (
    !result ||
    typeof result !== 'object' ||
    !('decodedDshHistory' in result) ||
    result.decodedDshHistory !== true ||
    !('content' in result) ||
    typeof result.content !== 'string'
  ) {
    throw new Error('Decoded DSH logs require a newer transcript-owning Orca host')
  }
  if (Buffer.byteLength(result.content, 'utf8') > 2 * 1024 * 1024) {
    throw new Error('Decoded DSH log exceeds client read limit')
  }
  return { content: result.content, isBinary: false, decodedDshHistory: true }
}

export async function readSshFileWithHistoryDecoding(
  mux: SshChannelMultiplexer,
  filePath: string,
  limits?: FileReadLimits
): Promise<FileReadResult> {
  if (limits?.decodeReasonixHistory) {
    const result = await mux.request('fs.readFile', { filePath, decodeReasonixHistory: true })
    if (
      !result ||
      typeof result !== 'object' ||
      !('decodedReasonixHistory' in result) ||
      result.decodedReasonixHistory !== true ||
      !('content' in result) ||
      typeof result.content !== 'string' ||
      !('isBinary' in result) ||
      result.isBinary !== false
    ) {
      throw new Error('Decoded Reasonix history requires a newer transcript-owning Orca host')
    }
    if (Buffer.byteLength(result.content, 'utf8') > 2 * 1024 * 1024) {
      throw new Error('Decoded Reasonix history exceeds client read limit')
    }
    return { content: result.content, isBinary: false, decodedReasonixHistory: true }
  }
  return limits?.decodeDshHistory
    ? readSshDecodedDshLog(mux, filePath)
    : readFileViaStream(mux, filePath, limits)
}
