import type { RuntimeDownloadErrorCode } from '../../shared/runtime-downloads/runtime-download-contract'
import { RuntimeDownloadError } from './runtime-download-transfer'

const HOST_MESSAGE_CODES: Record<string, RuntimeDownloadErrorCode> = {
  archive_too_large: 'too_large',
  archive_too_many_entries: 'too_many_entries',
  archive_busy: 'host_busy',
  archive_not_directory: 'not_a_directory',
  archive_canceled: 'canceled',
  file_too_large: 'too_large'
}

/** Maps a failed host reply onto a stable code the renderer can word. */
export function runtimeDownloadErrorFromResponse(error: {
  code: string
  message: string
}): RuntimeDownloadError {
  if (error.code === 'method_not_found') {
    return new RuntimeDownloadError('host_update_required', error.message)
  }
  const mapped = HOST_MESSAGE_CODES[error.message]
  if (mapped) {
    return new RuntimeDownloadError(mapped, error.message)
  }
  if (/ENOENT|not[_ ]found|no such file/i.test(error.message)) {
    return new RuntimeDownloadError('not_found', error.message)
  }
  if (/disconnect|unreachable|closed|timed? ?out|offline/i.test(`${error.code} ${error.message}`)) {
    return new RuntimeDownloadError('disconnected', error.message)
  }
  return new RuntimeDownloadError('transfer_failed', error.message)
}

export function toRuntimeDownloadError(error: unknown, signal: AbortSignal): RuntimeDownloadError {
  if (signal.aborted) {
    return new RuntimeDownloadError('canceled')
  }
  if (error instanceof RuntimeDownloadError) {
    return error
  }
  const message = error instanceof Error ? error.message : String(error)
  const rawCode =
    typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
  const code = typeof rawCode === 'string' ? rawCode : 'runtime_error'
  return runtimeDownloadErrorFromResponse({ code, message })
}
