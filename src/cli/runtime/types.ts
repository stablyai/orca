// Why: the RPC envelope shape is the contract the CLI shares with the main
// runtime. Keeping the types and error classes in one leaf module lets every
// other runtime module depend on them without pulling in transport or launch
// code.

export type RuntimeRpcSuccess<TResult> = {
  id: string
  ok: true
  result: TResult
  _meta: {
    runtimeId: string
  }
}

export type RuntimeRpcFailure = {
  id: string
  ok: false
  error: {
    code: string
    message: string
    data?: unknown
  }
  _meta?: {
    runtimeId: string | null
  }
}

export type RuntimeRpcResponse<TResult> = RuntimeRpcSuccess<TResult> | RuntimeRpcFailure

export class RuntimeClientError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

export class RuntimeRpcFailureError extends RuntimeClientError {
  readonly response: RuntimeRpcFailure

  constructor(response: RuntimeRpcFailure) {
    super(response.error.code, response.error.message)
    this.response = response
  }
}
