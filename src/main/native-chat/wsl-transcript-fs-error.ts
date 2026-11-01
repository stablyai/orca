import {
  AI_VAULT_SCAN_ISSUE_COPY,
  aiVaultScanIssueText,
  type AiVaultScanIssueText
} from '../../shared/ai-vault-scan-issue-copy'

export const WSL_TRANSCRIPT_FS_SLOW_MESSAGE = AI_VAULT_SCAN_ISSUE_COPY.wslTranscriptFsSlow
export const WSL_TRANSCRIPT_FS_CAPACITY_MESSAGE = AI_VAULT_SCAN_ISSUE_COPY.wslTranscriptFsCapacity
const WSL_TRANSCRIPT_FS_DISTRO_NOT_RUNNING_PREFIX = 'WSL transcript files are unavailable because'
const WSL_TRANSCRIPT_FS_PROCESS_FAILURE_PREFIX =
  'WSL transcript files are temporarily unavailable because the filesystem helper process failed'

export type WslTranscriptFsFailureCode = 'timeout' | 'capacity' | 'unavailable'

export class WslTranscriptFsError extends Error {
  constructor(
    readonly code: WslTranscriptFsFailureCode,
    message: string,
    /** Coded copy for scan-issue rows; absent for ad-hoc messages. */
    readonly text?: AiVaultScanIssueText
  ) {
    super(message)
    this.name = 'WslTranscriptFsError'
  }
}

function codedError(
  code: WslTranscriptFsFailureCode,
  text: AiVaultScanIssueText
): WslTranscriptFsError {
  return new WslTranscriptFsError(code, text.message, text)
}

export function wslTranscriptFsTimeoutError(): WslTranscriptFsError {
  return codedError('timeout', aiVaultScanIssueText('wslTranscriptFsSlow'))
}

export function wslTranscriptFsCapacityError(): WslTranscriptFsError {
  return codedError('capacity', aiVaultScanIssueText('wslTranscriptFsCapacity'))
}

export function wslTranscriptFsUnavailableError(): WslTranscriptFsError {
  return codedError('unavailable', aiVaultScanIssueText('wslTranscriptFsSlow'))
}

/** Helper-process transport fault: nothing was consulted about the mount. */
export function wslTranscriptFsProcessFailureError(detail: unknown): WslTranscriptFsError {
  const text = detail instanceof Error ? detail.message : String(detail)
  return codedError(
    'unavailable',
    aiVaultScanIssueText('wslTranscriptFsProcessFailed', { detail: text })
  )
}

/** Reading would boot the distro (E9), or WSL couldn't say it runs; nothing touched its files. */
export function wslTranscriptFsDistroNotRunningError(
  distro: string,
  state: 'stopped' | 'unverifiable'
): WslTranscriptFsError {
  return codedError(
    'unavailable',
    aiVaultScanIssueText(state === 'stopped' ? 'wslDistroNotRunning' : 'wslDistroUnverifiable', {
      params: { distro }
    })
  )
}

export function isWslTranscriptFsRefusalMessage(message: string): boolean {
  return (
    message === WSL_TRANSCRIPT_FS_SLOW_MESSAGE ||
    message.startsWith(WSL_TRANSCRIPT_FS_DISTRO_NOT_RUNNING_PREFIX) ||
    message === WSL_TRANSCRIPT_FS_CAPACITY_MESSAGE ||
    message.startsWith(WSL_TRANSCRIPT_FS_PROCESS_FAILURE_PREFIX)
  )
}

export function wslTranscriptFsRefusal(error: unknown): WslTranscriptFsError {
  if (error instanceof WslTranscriptFsError) {
    return error
  }
  throw error
}
