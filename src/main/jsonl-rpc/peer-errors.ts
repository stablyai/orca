export class JsonlRpcStreamClosedError extends Error {
  constructor() {
    super('Agent JSON-lines RPC stream closed')
    this.name = 'JsonlRpcStreamClosedError'
  }
}
export class JsonlRpcResponseError extends Error {
  constructor(
    readonly command: string,
    message: string
  ) {
    super(message)
    this.name = 'JsonlRpcResponseError'
  }
}
