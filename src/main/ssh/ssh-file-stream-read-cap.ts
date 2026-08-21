import type { FileReadLimits } from '../providers/types'
import {
  MAX_PREVIEWABLE_BINARY_BYTES,
  MAX_TEXT_FILE_BYTES
} from '../../shared/previewable-binary-mime-types'

const MAX_PREVIEWABLE_BINARY_SIZE = MAX_PREVIEWABLE_BINARY_BYTES
const MAX_TEXT_FILE_SIZE = MAX_TEXT_FILE_BYTES

export function sshFileStreamReadCap(isBinary: boolean, limits?: FileReadLimits): number {
  const defaultCap = isBinary ? MAX_PREVIEWABLE_BINARY_SIZE : MAX_TEXT_FILE_SIZE
  const requestedCap = isBinary ? limits?.maxBinaryBytes : limits?.maxTextBytes
  return requestedCap === undefined ? defaultCap : Math.min(defaultCap, requestedCap)
}
