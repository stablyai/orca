import { wslTranscriptFsProcessFailureError } from './wsl-transcript-fs-error'
import { invalidTranscriptHandleError } from './wsl-transcript-fs-process-protocol'
import type { WslTranscriptFsProcessClient } from './wsl-transcript-fs-process-client'
import type { WslTranscriptFsProcessHandle } from './wsl-transcript-fs-process-slot'

export const wslTranscriptFsHandleOwners = new WeakMap<
  WslTranscriptFsProcessHandle,
  WslTranscriptFsProcessClient
>()

export function processHandleUnavailableError(
  handle: WslTranscriptFsProcessHandle,
  faultedHandles: WeakSet<WslTranscriptFsProcessHandle>
): Error {
  return faultedHandles.has(handle)
    ? wslTranscriptFsProcessFailureError('the process owning this file handle exited')
    : invalidTranscriptHandleError()
}
