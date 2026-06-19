export class RuntimeClientError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'RuntimeClientError'
    this.code = code
  }
}
