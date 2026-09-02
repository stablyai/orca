/** Codex answered the call and refused it, rather than timing out or exiting. */
export class CodexAppServerRequestError extends Error {
  constructor(
    readonly method: string,
    readonly code: number | null,
    message: string
  ) {
    super(message)
    this.name = 'CodexAppServerRequestError'
  }
}

export function isCodexAppServerRequestError(error: unknown): error is CodexAppServerRequestError {
  return error instanceof Error && error.name === 'CodexAppServerRequestError'
}
