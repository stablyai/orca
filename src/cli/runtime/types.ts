import type { RuntimeRpcFailure } from '../../shared/runtime-rpc-envelope'

export type {
  RuntimeRpcFailure,
  RuntimeRpcResponse,
  RuntimeRpcSuccess
} from '../../shared/runtime-rpc-envelope'

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
