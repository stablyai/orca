/** Import scratch, its disk reserve or its worker refused; the import degrades instead of failing. */
export class ClaudeImportResourceError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ClaudeImportResourceError'
  }
}
