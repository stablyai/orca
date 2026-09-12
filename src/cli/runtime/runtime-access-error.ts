import { RuntimeClientError } from './types'

const OPERATION_DESCRIPTION = {
  connect: 'connect to the Orca runtime',
  probe_process: 'check the Orca runtime process',
  read_metadata: 'read Orca runtime metadata'
} as const

export class RuntimeAccessError extends RuntimeClientError {
  constructor(operation: keyof typeof OPERATION_DESCRIPTION, systemCode: string) {
    super(
      'runtime_unavailable',
      `Permission denied while trying to ${OPERATION_DESCRIPTION[operation]} (${systemCode}). Check this command's sandbox and OS permissions; the app's running state is unverifiable.`,
      { reason: 'permission_denied', operation, systemCode, processState: 'unverifiable' }
    )
  }
}

export function isRuntimePermissionError(
  error: unknown
): error is NodeJS.ErrnoException & { code: 'EPERM' | 'EACCES' } {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'EPERM' || code === 'EACCES'
}
