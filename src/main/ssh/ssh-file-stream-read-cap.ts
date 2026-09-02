import type { FileReadLimits } from '../providers/types'

const MAX_PREVIEWABLE_BINARY_SIZE = 50 * 1024 * 1024
const MAX_TEXT_FILE_SIZE = 10 * 1024 * 1024

export function sshFileStreamReadCap(isBinary: boolean, limits?: FileReadLimits): number {
  const defaultCap = isBinary ? MAX_PREVIEWABLE_BINARY_SIZE : MAX_TEXT_FILE_SIZE
  const requestedCap = isBinary ? limits?.maxBinaryBytes : limits?.maxTextBytes
  return requestedCap === undefined ? defaultCap : Math.min(defaultCap, requestedCap)
}
