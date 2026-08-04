export type FilesystemHostProcessFailureCode =
  | 'deadline'
  | 'outcome-unknown'
  | 'process-unavailable'
  | 'protocol'
  | 'operation'

export class FilesystemHostProcessError extends Error {
  constructor(
    readonly code: FilesystemHostProcessFailureCode,
    message: string,
    readonly operationCode?: string
  ) {
    super(message)
    this.name = 'FilesystemHostProcessError'
  }
}
