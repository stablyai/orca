import type { FilesystemHostResult } from '../../shared/filesystem-host-protocol'
import { FilesystemHostSupervisorError } from './filesystem-host-supervisor-error'

export type FilesystemHostReadFailureReason =
  | 'missing'
  | 'denied'
  | 'not-directory'
  | 'too-large'
  | 'invalid'
  | 'deadline'
  | 'unavailable'

const NODE_ERROR_CODE_BY_REASON: Record<FilesystemHostReadFailureReason, string> = {
  missing: 'ENOENT',
  denied: 'EACCES',
  'not-directory': 'ENOTDIR',
  'too-large': 'EFBIG',
  invalid: 'EINVAL',
  deadline: 'ETIMEDOUT',
  unavailable: 'EHOSTUNREACH'
}

export class FilesystemHostReadError extends Error {
  readonly code: string

  constructor(readonly reason: FilesystemHostReadFailureReason) {
    super(
      reason === 'deadline'
        ? 'Filesystem operation timed out'
        : reason === 'unavailable'
          ? 'Filesystem host is unavailable'
          : `Filesystem read failed (${reason})`
    )
    this.name = 'FilesystemHostReadError'
    this.code = NODE_ERROR_CODE_BY_REASON[reason]
  }
}

export function filesystemHostReadFailureReason(error: unknown): FilesystemHostReadFailureReason {
  if (!(error instanceof FilesystemHostSupervisorError)) {
    return 'unavailable'
  }
  if (error.code === 'deadline') {
    return 'deadline'
  }
  if (error.code !== 'operation') {
    return 'unavailable'
  }
  switch (error.operationCode) {
    case 'missing':
    case 'denied':
    case 'not-directory':
    case 'too-large':
    case 'invalid':
      return error.operationCode
    case undefined:
    default:
      return 'unavailable'
  }
}

export function requireFilesystemHostResult<T extends FilesystemHostResult['kind']>(
  result: FilesystemHostResult,
  kind: T
): Extract<FilesystemHostResult, { kind: T }> {
  if (result.kind !== kind) {
    throw new FilesystemHostReadError('unavailable')
  }
  return result as Extract<FilesystemHostResult, { kind: T }>
}
