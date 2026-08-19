import type { RuntimeRpcFailure } from '../../shared/runtime-rpc-envelope'
import { redactOrchestrationCompatibilitySecrets } from '../../shared/orchestration-compatibility-evidence'

export type {
  RuntimeRpcFailure,
  RuntimeRpcResponse,
  RuntimeRpcSuccess
} from '../../shared/runtime-rpc-envelope'

// Why: the OS denied access to the transport path. 'runtime_unavailable' would
// tell the user to restart Orca, which recreates it with the same permissions.
export const RUNTIME_PERMISSION_DENIED_CODE = 'runtime_permission_denied'

const PERMISSION_DENIED_SYSCALL_CODES: ReadonlySet<string> = new Set(['EACCES', 'EPERM'])

// Covers both Unix domain sockets and Windows named pipes, which surface a denied
// transport path as EACCES/EPERM on connect.
export function isPermissionDeniedSyscallCode(code: string | undefined): boolean {
  return code !== undefined && PERMISSION_DENIED_SYSCALL_CODES.has(code)
}

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

export function isRuntimePermissionDeniedError(error: unknown): boolean {
  return error instanceof RuntimeClientError && error.code === RUNTIME_PERMISSION_DENIED_CODE
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
