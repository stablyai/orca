import type { PipelineStore } from '../pipeline-store'
import {
  PipelineV2TemplateDisableInput,
  PipelineV2TemplatePublishInput,
  PipelineV2TemplateReceipt
} from '../../../../shared/pipelines/v2/pipeline-v2-template-contracts'
import { pipelineV2Fingerprint } from '../../../../shared/pipelines/v2/pipeline-v2-fingerprint'
import { commandPipelineV2 } from './pipeline-v2-execution'

export type PipelineTemplateOwnerActions = {
  publishTemplate: (input: unknown) => Promise<PipelineV2TemplateReceipt>
  disableTemplate: (input: unknown) => Promise<PipelineV2TemplateReceipt>
}
export function createPipelineTemplateOwnerActions(runtime: {
  store: PipelineStore
  assertProject: (id: string) => Promise<void>
  wake: () => void
}): PipelineTemplateOwnerActions {
  const assertProposal = (
    kind: 'publish' | 'disable',
    input: { projectId: string; requestId: string }
  ) => {
    const proposal = runtime.store.ownerRequestsV2.get(input.projectId, input.requestId)
    if (!proposal) {
      return
    }
    const { expectedRuntimeId: _runtimeId, ...original } = proposal.input
    if (
      proposal.kind !== kind ||
      pipelineV2Fingerprint(original) !== pipelineV2Fingerprint(input)
    ) {
      throw new Error('pipeline_request_conflict')
    }
  }
  return {
    publishTemplate: async (raw) => {
      const input = PipelineV2TemplatePublishInput.parse(raw)
      assertProposal('publish', input)
      await runtime.assertProject(input.projectId)
      const { definition } = runtime.store.templatesV2.publish(input)
      runtime.wake()
      return PipelineV2TemplateReceipt.parse({
        requestId: input.requestId,
        action: 'published',
        enabled: true,
        selection: {
          engineVersion: 2,
          projectId: definition.projectId,
          id: definition.id,
          version: definition.version,
          digest: definition.digest
        }
      })
    },
    disableTemplate: async (raw) => {
      const input = PipelineV2TemplateDisableInput.parse(raw)
      assertProposal('disable', input)
      await runtime.assertProject(input.projectId)
      const receipt = runtime.store.templatesV2.setEnabled(input)
      if (runtime.store.templatesV2.getVersion(receipt.selection).enabled === input.enabled) {
        for (const run of runtime.store.pendingV2()) {
          if (
            run.definition.projectId === input.projectId &&
            run.definition.id === input.id &&
            run.definition.version === input.version &&
            run.definitionDigest === input.digest &&
            run.definitionEnabled !== input.enabled
          ) {
            commandPipelineV2(
              runtime.store,
              run.id,
              { kind: input.enabled ? 'definition_enabled' : 'definition_disabled' },
              `template:${pipelineV2Fingerprint(input)}:${run.id}:${run.revision}`
            )
          }
        }
      }
      runtime.wake()
      return receipt
    }
  }
}
