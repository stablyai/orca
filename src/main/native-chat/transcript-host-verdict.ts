import { FileRangeReadUnsupportedError } from '../providers/types'
import { SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE } from '../providers/ssh-filesystem-dispatch'
import { WslTranscriptFsError } from './wsl-transcript-fs-gate'

export const TRANSCRIPT_UNVERIFIABLE_MESSAGE = 'Transcript unverifiable on the remote host'

export class TranscriptHostUnverifiableError extends Error {
  constructor(message = TRANSCRIPT_UNVERIFIABLE_MESSAGE) {
    super(message)
    this.name = 'TranscriptHostUnverifiableError'
  }
}

export function isTranscriptHostUnverifiableError(error: unknown): boolean {
  if (
    error instanceof TranscriptHostUnverifiableError ||
    error instanceof FileRangeReadUnsupportedError
  ) {
    return true
  }
  const candidate = error as { code?: unknown; message?: unknown } | null
  return (
    candidate?.code === 'CONNECTION_LOST' ||
    candidate?.code === 'DISPOSED' ||
    candidate?.code === 'SSH_SESSION_EXPIRED' ||
    candidate?.message === SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE
  )
}

export function transcriptUnverifiableResult(): { error: string } {
  return { error: TRANSCRIPT_UNVERIFIABLE_MESSAGE }
}

export function transcriptInitialReadErrorMessage(error: unknown): string {
  if (error instanceof WslTranscriptFsError) {
    return error.message
  }
  return isTranscriptHostUnverifiableError(error)
    ? TRANSCRIPT_UNVERIFIABLE_MESSAGE
    : 'Transcript unavailable'
}
