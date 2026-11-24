import type { PipelineStore } from '../pipeline-store'
import type { PipelineV2Run } from '../../../../shared/pipelines/v2/pipeline-v2-run-contracts'
import type { PipelineV2Receipt } from '../../../../shared/pipelines/v2/pipeline-v2-results'
import { pipelineV2Fingerprint } from '../../../../shared/pipelines/v2/pipeline-v2-fingerprint'
import {
  PipelineV2OwnerInput,
  type PipelineV2DecisionInput,
  type PipelineV2BudgetInput
} from '../../../../shared/pipelines/v2/pipeline-v2-owner-contracts'

export type PipelineOwnerActions = {
  resolveDecision: (input: PipelineV2DecisionInput) => Promise<PipelineV2Receipt>
  resolveBudget: (input: PipelineV2BudgetInput) => Promise<PipelineV2Receipt>
}
export type PipelineV2OwnerDependencies = {
  store: PipelineStore
  assertWorkspace: (workspace: PipelineV2Run['workspace']) => Promise<void>
  sourceRevision: (workspace: PipelineV2Run['workspace']) => Promise<string>
  reviewCommit?: (workspace: PipelineV2Run['workspace']) => Promise<string>
  wake: () => void
}

export function createPipelineOwnerActions(
  runtime: PipelineV2OwnerDependencies & { getRuntimeId: () => string }
): PipelineOwnerActions {
  const resolve = async (raw: unknown, kind: 'decide' | 'extend_budget') => {
    const input = PipelineV2OwnerInput.parse(raw)
    const assertRuntime = () => {
      if (input.expectedRuntimeId !== runtime.getRuntimeId()) {
        throw new Error('pipeline_runtime_identity_changed')
      }
    }
    assertRuntime()
    if (input.mutation.command.kind !== kind) {
      throw new Error('pipeline_owner_command_invalid')
    }
    const run = runtime.store.getV2(input.id)
    const proposal = runtime.store.ownerRequestsV2.get(input.projectId, input.mutation.requestId)
    if (proposal) {
      if (
        (proposal.kind !== 'decision' && proposal.kind !== 'budget') ||
        proposal.input.id !== input.id ||
        proposal.input.expectedRuntimeId !== input.expectedRuntimeId
      ) {
        throw new Error('pipeline_request_conflict')
      }
      const command =
        proposal.kind === 'decision'
          ? {
              kind: 'decide',
              ...proposal.input.pin,
              action: proposal.input.action,
              ...(proposal.input.comment ? { comment: proposal.input.comment } : {})
            }
          : { kind: 'extend_budget', ...proposal.input.extension }
      const expected = {
        requestId: proposal.requestId,
        expectedRevision: proposal.input.expectedRevision,
        expectedInstanceId: proposal.input.expectedInstanceId,
        command
      }
      if (pipelineV2Fingerprint(expected) !== pipelineV2Fingerprint(input.mutation)) {
        throw new Error('pipeline_request_conflict')
      }
    }
    if (run.workspace.id !== input.workspaceId || run.workspace.projectId !== input.projectId) {
      throw new Error('pipeline_workspace_instance_changed')
    }
    await runtime.assertWorkspace(run.workspace)
    if (
      !runtime.store.receiptV2(input.id, input.mutation.requestId) &&
      kind === 'decide' &&
      (await runtime.sourceRevision(run.workspace)) !== run.sourceRevision
    ) {
      throw new Error('pipeline_source_changed')
    }
    assertRuntime()
    runtime.store.commandV2(input.id, input.mutation)
    runtime.wake()
    return runtime.store.receiptV2(input.id, input.mutation.requestId)!
  }
  return {
    resolveDecision: (input) => resolve(input, 'decide'),
    resolveBudget: (input) => resolve(input, 'extend_budget')
  }
}
