import { WslTranscriptFsError } from '../../native-chat/transcript-filesystem/wsl-transcript-fs-error'

/** A missing file or folder is absence, not a refusal; WSL gate errors are always refusals. */
export function isMissingTranscriptPathError(error: unknown): boolean {
  if (error instanceof WslTranscriptFsError) {
    return false
  }
  const code =
    error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : null
  return code === 'ENOENT' || code === 'ENOTDIR'
}
