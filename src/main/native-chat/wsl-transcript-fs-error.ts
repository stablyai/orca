export const WSL_TRANSCRIPT_FS_SLOW_MESSAGE =
  'WSL transcript files are temporarily unavailable because filesystem access is taking too long. Try again shortly or restart Orca if the issue continues.'
export const WSL_TRANSCRIPT_FS_CAPACITY_MESSAGE =
  'WSL transcript discovery is temporarily unavailable because too many filesystem requests are already waiting. Try again shortly or restart Orca if the issue continues.'
const WSL_TRANSCRIPT_FS_PROCESS_FAILURE_PREFIX =
  'WSL transcript files are temporarily unavailable because the filesystem helper process failed'

export type WslTranscriptFsFailureCode = 'timeout' | 'capacity' | 'unavailable'

export class WslTranscriptFsError extends Error {
  constructor(
    readonly code: WslTranscriptFsFailureCode,
    message: string
  ) {
    super(message)
    this.name = 'WslTranscriptFsError'
  }
}

export function wslTranscriptFsTimeoutError(): WslTranscriptFsError {
  return new WslTranscriptFsError('timeout', WSL_TRANSCRIPT_FS_SLOW_MESSAGE)
}

export function wslTranscriptFsCapacityError(): WslTranscriptFsError {
  return new WslTranscriptFsError('capacity', WSL_TRANSCRIPT_FS_CAPACITY_MESSAGE)
}

export function wslTranscriptFsUnavailableError(): WslTranscriptFsError {
  return new WslTranscriptFsError('unavailable', WSL_TRANSCRIPT_FS_SLOW_MESSAGE)
}

/** Helper-process transport fault: nothing was consulted about the mount. */
export function wslTranscriptFsProcessFailureError(detail: unknown): WslTranscriptFsError {
  const text = detail instanceof Error ? detail.message : String(detail)
  return new WslTranscriptFsError(
    'unavailable',
    `${WSL_TRANSCRIPT_FS_PROCESS_FAILURE_PREFIX} (${text}). Try again shortly or restart Orca if the issue continues.`
  )
}

/** Layers that only see a flattened message use this to spot a refusal. */
export function isWslTranscriptFsRefusalMessage(message: string): boolean {
  return (
    message === WSL_TRANSCRIPT_FS_SLOW_MESSAGE ||
    message === WSL_TRANSCRIPT_FS_CAPACITY_MESSAGE ||
    message.startsWith(WSL_TRANSCRIPT_FS_PROCESS_FAILURE_PREFIX)
  )
}

/** Narrow a caught error to a gate refusal, rethrowing anything else. */
export function wslTranscriptFsRefusal(error: unknown): WslTranscriptFsError {
  if (error instanceof WslTranscriptFsError) {
    return error
  }
  throw error
}
