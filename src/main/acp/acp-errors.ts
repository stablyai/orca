export class AcpRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown
  ) {
    super(message)
    this.name = 'AcpRpcError'
  }
}

export class AcpAuthRequiredError extends AcpRpcError {
  constructor(message: string, data?: unknown) {
    super(-32000, message, data)
    this.name = 'AcpAuthRequiredError'
  }
}

export class AcpConnectionClosedError extends Error {
  constructor(message = 'ACP connection closed') {
    super(message)
    this.name = 'AcpConnectionClosedError'
  }
}

export class AcpRequestTimeoutError extends Error {
  constructor(readonly method: string) {
    super(`ACP request timed out: ${method}`)
    this.name = 'AcpRequestTimeoutError'
  }
}
