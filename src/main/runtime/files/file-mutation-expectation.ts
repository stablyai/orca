import {
  getSshTargetIdForExecutionHost,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { assertSshMutationExpectation } from '../../ssh/connection/ssh-connection-generation'

export const RUNTIME_FILE_MUTATION_UPDATE_REQUIRED =
  'Remote file changes require a newer Orca client. Update the paired client and try again.'

export function assertRuntimeFileMutationExpectation(
  // #11163: use the resolved host; connectionId would collapse runtime/unresolved to local.
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
