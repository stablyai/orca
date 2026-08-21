export class OrchestrationError extends Error {
  readonly code: string
  readonly data?: unknown

  constructor(code: string, message: string, data?: unknown) {
    super(message)
    this.name = 'OrchestrationError'
    this.code = code
    this.data = data
  }
}
