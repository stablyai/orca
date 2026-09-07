import type { RuntimeRpcFailure } from '../../shared/runtime-rpc-envelope'
import { redactOrchestrationCompatibilitySecrets } from '../../shared/orchestration-compatibility-evidence'

export type {
  RuntimeRpcFailure,
  RuntimeRpcResponse,
  RuntimeRpcSuccess
} from '../../shared/runtime-rpc-envelope'

export class RuntimeClientError extends Error {
  readonly code: string
  // Why: optional structured recovery payload (e.g. did-you-mean suggestions,
  // valid-flag enumeration) surfaced into both the human and --json error output.
  readonly data?: unknown

  constructor(code: string, message: string, data?: unknown) {
    super(message)
    this.code = code
    this.data = redactOrchestrationCompatibilitySecrets(data)
  }
}

export class RuntimeRpcFailureError extends RuntimeClientError {
  readonly response: RuntimeRpcFailure

  constructor(response: RuntimeRpcFailure) {
    // Why: all client errors expose recovery through the same inherited channel.
    super(response.error.code, response.error.message, response.error.data)
    this.response = {
      ...response,
      error: {
        ...response.error,
        ...(response.error.data === undefined ? {} : { data: this.data })
      }
    }
  }
}
