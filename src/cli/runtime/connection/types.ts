import type {
  RuntimeOrchestrationEnvelope,
  RuntimeRequestSelection,
  RuntimeRpcFailure
} from '../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import { redactOrchestrationCompatibilitySecrets } from '../../../shared/orchestration/orchestration-compatibility-evidence'

export type RuntimeCallOptions = {
  timeoutMs?: number
  legacyTerminalPrompt?: true
  terminalPromptPreflight?: { runtimeId: string | null }
  /** The local runtime whose capabilities shaped this request; a restart must not redirect it to another. */
  preflightRuntimeId?: string | null | undefined
  requestSelection?: RuntimeRequestSelection
  /** Send under the replay-only contract: the runtime may replay or join this request id, never run it anew. */
  orchestrationReplayOnly?: true
} & RuntimeOrchestrationEnvelope

export class RuntimeClientError extends Error {
  readonly code: string
  // Structured recovery data is exposed in both human and JSON errors.
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
