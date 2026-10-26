export class CodexAppServerFrameSizeError extends Error {
  constructor(
    readonly method: string | null,
    readonly observedBytes: number,
    readonly maxBytes: number
  ) {
    super(
      `codex app-server${method ? ` ${method}` : ''} response exceeds ${maxBytes} byte limit (${observedBytes} bytes received)`
    )
    this.name = 'CodexAppServerFrameSizeError'
  }
}
