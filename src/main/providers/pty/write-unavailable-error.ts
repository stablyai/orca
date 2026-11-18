export class PtyWriteUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PtyWriteUnavailableError'
  }
}

export function isPtyWriteUnavailableError(error: unknown): error is PtyWriteUnavailableError {
  return error instanceof PtyWriteUnavailableError
}
