import type { FileReadLimits } from '../providers/types'
import {
  EDITOR_PREVIEWABLE_BINARY_MAX_BYTES,
  EDITOR_TEXT_READ_LIMIT_BYTES
} from '../../shared/editor-file-read-limit'

export function sshFileStreamReadCap(isBinary: boolean, limits?: FileReadLimits): number {
  const defaultCap = isBinary
    ? EDITOR_PREVIEWABLE_BINARY_MAX_BYTES
    : EDITOR_TEXT_READ_LIMIT_BYTES.ssh
  const requestedCap = isBinary ? limits?.maxBinaryBytes : limits?.maxTextBytes
  return requestedCap === undefined ? defaultCap : Math.min(defaultCap, requestedCap)
}
