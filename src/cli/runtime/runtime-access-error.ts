import { RuntimeClientError } from './types'

const OPERATION_DESCRIPTION = {
  connect: 'connect to the Orca runtime',
  probe_process: 'check the Orca runtime process',
  read_metadata: 'read Orca runtime metadata'
} as const

export function systemErrorCode(error: unknown): string | undefined {
  return error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined
}

export function isRuntimePermissionError(error: unknown): boolean {
  const code = systemErrorCode(error)
  return code === 'EPERM' || code === 'EACCES'
}

export class RuntimeAccessError extends RuntimeClientError {
  constructor(
    operation: keyof typeof OPERATION_DESCRIPTION,
    systemCode: string | undefined,
    pid?: number
  ) {
    const denied = systemCode === 'EPERM' || systemCode === 'EACCES'
    super(
      denied ? 'runtime_permission_denied' : 'runtime_unverifiable',
      `${denied ? 'Permission denied' : 'Unable to verify access'} while trying to ${OPERATION_DESCRIPTION[operation]}${systemCode ? ` (${systemCode})` : ''}. ${denied ? "Check this command's sandbox and OS permissions. " : ''}The app's running state is unverifiable.`,
      {
        reason: denied ? 'permission_denied' : 'probe_failed',
        operation,
        ...(systemCode ? { systemCode } : {}),
        processState: 'unverifiable',
        // The metadata PID is a diagnostic hint, not verified process ownership.
        ...(pid === undefined ? {} : { pid })
      }
    )
  }
}

export function isRuntimeAccessError(error: unknown): boolean {
  return (
    error instanceof RuntimeClientError &&
    (error.code === 'runtime_permission_denied' || error.code === 'runtime_unverifiable')
  )
}
