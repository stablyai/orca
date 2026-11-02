import {
  getSshTargetIdForExecutionHost,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { assertSshMutationExpectation } from '../../ssh/ssh-connection-generation'

export const RUNTIME_FILE_MUTATION_UPDATE_REQUIRED =
  'Remote file changes require a newer Orca client. Update the paired client and try again.'

export function assertRuntimeFileMutationExpectation(
  // The resolved host, not a repo row's connection: recomputing it from `connectionId` here spelled
  // `runtime:<env>` and "unresolved" as `local`, so a client's host expectation could pass against
  // a host it never named (#11163).
  executionHostId: ExecutionHostId,
  expectedExecutionHostId: string | undefined,
  expectedSshTargetId: string | undefined,
  expectedSshConnectionGeneration: number | undefined
): void {
  if (!expectedExecutionHostId) {
    throw new Error(RUNTIME_FILE_MUTATION_UPDATE_REQUIRED)
  }
  if (expectedExecutionHostId !== executionHostId) {
    throw new Error('Workspace host changed; refresh and try again')
  }
  assertSshMutationExpectation(
    getSshTargetIdForExecutionHost(executionHostId) ?? undefined,
    expectedSshTargetId,
    expectedSshConnectionGeneration
  )
}
