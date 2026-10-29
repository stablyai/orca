import type { FilesystemHostErrorCode } from '../../shared/filesystem-host-protocol'

export class FilesystemHostOperationError extends Error {
  constructor(
    readonly code: FilesystemHostErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'FilesystemHostOperationError'
  }
}

export function classifyError(error: unknown): FilesystemHostOperationError {
  const code = (error as NodeJS.ErrnoException | null)?.code
  const classified: FilesystemHostErrorCode =
    code === 'ENOENT'
      ? 'missing'
      : code === 'EACCES' || code === 'EPERM'
        ? 'denied'
        : code === 'ENOTDIR' || code === 'EISDIR'
          ? 'not-directory'
          : code === 'EINVAL'
            ? 'invalid'
            : 'io'
  return new FilesystemHostOperationError(
    classified,
    `Filesystem operation failed${code ? ` (${code})` : ''}`
  )
}
