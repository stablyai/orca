import type { ExecutionHostId } from '../../../src/shared/execution-host'

/**
 * The envelope field naming the host a workspace call runs on. Absent means the paired desktop,
 * which is every call an old page or an old desktop makes.
 */
export function rpcExecutionHostEnvelope(executionHost: ExecutionHostId | undefined): {
  executionHost?: ExecutionHostId
} {
  return executionHost ? { executionHost } : {}
}
