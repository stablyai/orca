/** A bounded import could not verify or prepare history. The same source can be retried. */
export class ClaudeImportResourceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ClaudeImportResourceError'
  }
}
