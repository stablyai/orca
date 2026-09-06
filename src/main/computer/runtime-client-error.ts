export class RuntimeClientError extends Error {
  readonly code: string
  // Optional for mixed-version native helpers and sidecar peers.
  readonly data?: unknown

  constructor(code: string, message: string, data?: unknown) {
    super(message)
    this.name = 'RuntimeClientError'
    this.code = code
    this.data = data
  }
}
