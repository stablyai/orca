import { readTranscriptSlice } from '../native-chat/wsl-transcript-fs-access'
import type { FileWithMtime, ResumableSessionParseState } from './session-scanner-types'

const NEWLINE_BYTE = 0x0a

export type FileIdentity = { dev: number; ino: number }

export type ResumePoint = {
  state: ResumableSessionParseState
  // Byte offset just past the last complete ('\n'-terminated) line consumed;
  // a trailing unterminated line is deliberately left before this point.
  byteOffset: number
  // Inode the offset belongs to; null when discovery could not stat identity.
  identity: FileIdentity | null
}

export function fileIdentity(file: FileWithMtime): FileIdentity | null {
  return typeof file.dev === 'number' && typeof file.ino === 'number'
    ? { dev: file.dev, ino: file.ino }
    : null
}

// A rename-replace (atomic rewrite) keeps the path and can keep '\n' at the
// old offset, so the newline guard alone would resume into a different file.
// Identity is only compared when both sides have it; a candidate without a
// stat (synthetic files) keeps the newline-only heuristic.
export function sameFileIdentity(
  previous: FileIdentity | null,
  current: FileIdentity | null
): boolean {
  if (previous === null || current === null) {
    return true
  }
  return previous.dev === current.dev && previous.ino === current.ino
}

// A resume point is only valid if it still sits just past a line break;
// anything else means the file was rewritten in place, not appended. An
// in-place grown rewrite keeping '\n' at exactly this byte still slips
// through (rename-replace is caught by the inode check above); agent
// transcripts are append-only so that residual trade is accepted.
export async function endsWithNewlineAt(path: string, offset: number): Promise<boolean> {
  const slice = await readTranscriptSlice(path, offset - 1, 1, 'scan')
  return slice.length === 1 && slice[0] === NEWLINE_BYTE
}
