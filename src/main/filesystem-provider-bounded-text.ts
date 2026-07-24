import { measureUtf8ByteLength } from '../shared/utf8-byte-limits'
import type { IFilesystemProvider } from './providers/types'

export type FilesystemProviderBoundedText =
  | { kind: 'text'; content: string }
  | { kind: 'binary' }
  | { kind: 'oversized' }

export async function readFilesystemProviderBoundedText(
  provider: IFilesystemProvider,
  filePath: string,
  limits: { maxBytes: number; maxCodeUnits: number }
): Promise<FilesystemProviderBoundedText> {
  const fileStat = await provider.stat(filePath)
  if (
    !Number.isSafeInteger(fileStat.size) ||
    fileStat.size < 0 ||
    fileStat.size > limits.maxBytes
  ) {
    return { kind: 'oversized' }
  }

  const result = await provider.readFile(filePath)
  if (result.isBinary) {
    return { kind: 'binary' }
  }
  if (
    result.content.length > limits.maxCodeUnits ||
    measureUtf8ByteLength(result.content, { stopAfterBytes: limits.maxBytes }).exceededLimit
  ) {
    return { kind: 'oversized' }
  }
  return { kind: 'text', content: result.content }
}
