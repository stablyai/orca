import { defineMethod } from '../../core'
import * as z from 'zod'
import {
  PipelineV2RunParams,
  PipelineV2DescribeParams,
  PipelineV2EventsParams,
  PipelineV2ControlParams,
  PipelineV2DiscussParams
} from '../../../../../shared/rpc-contract/pipeline-v2-params'
import { PipelineV2StatusResult } from '../../../../../shared/pipelines/v2/pipeline-v2-public-results'
import { pipelineV2SubmitSchema } from '../../../../../shared/pipelines/v2/pipeline-v2-submit-contract'
import { PIPELINE_V2_CONTROL_METHODS } from './pipeline-v2-controls'
import { PIPELINE_V2_RECOVERY_METHODS } from './pipeline-v2-recovery-methods'
import { PIPELINE_V2_REQUEST_METHODS } from './pipeline-v2-requests'
import {
  pipelineV2Status,
  scopedPipelineV2,
  assertPipelineV2Runtime,
  pipelineV2Summary
} from './pipeline-v2-scope'
import { pipelineV2Events } from '../../../pipelines/v2/pipeline-v2-events'
import { PIPELINE_V2_TEMPLATE_METHODS } from './pipeline-v2-template-methods'
import { PIPELINE_V2_LIST_METHODS } from './pipeline-v2-list-methods'
import { assertPipelineV2Project } from './pipeline-v2-template-source'
import { PipelineCheck } from '../../../../../shared/pipelines/pipeline-contracts'
import { discussPipelineV2 } from '../../../pipelines/v2/pipeline-v2-discussion'
import { pipelineV2MandatoryContext } from '../../../pipelines/v2/pipeline-v2-context'

export const PIPELINE_V2_METHODS = [
  ...PIPELINE_V2_TEMPLATE_METHODS,
  ...PIPELINE_V2_LIST_METHODS,
  ...PIPELINE_V2_CONTROL_METHODS,
  ...PIPELINE_V2_RECOVERY_METHODS,
  ...PIPELINE_V2_REQUEST_METHODS,
  defineMethod({
    name: 'pipeline.v2.discuss',
    permission: 'host-admin',
    params: PipelineV2DiscussParams,
    handler: async (input, ctx) => {
      await scopedPipelineV2(ctx, input)
      const service = ctx.runtime.pipelineRuntime
      const { projectId: _project, expectedRuntimeId: _runtime, ...discussion } = input
      const receipt = await discussPipelineV2(
        {
          store: service.store,
          controller: service.controller,
          assertWorkspace: (workspace) => service.assertWorkspace(workspace),
          sourceRevision: service.v2Ports.sourceRevision,
          reviewCommit: service.v2Ports.reviewCommit,
          wake: () => service.wake()
        },
        discussion
      )
      return {
        contractVersion: 2 as const,
        receipt,
        run: pipelineV2Summary(await service.store.getV2(input.id))
      }
    }
  }),
  defineMethod({
    name: 'pipeline.v2.status',
    permission: 'workspace',
    params: PipelineV2RunParams,
    handler: async (input, ctx) => PipelineV2StatusResult.parse(await pipelineV2Status(ctx, input))
  }),
  defineMethod({
    name: 'pipeline.v2.describe',
    permission: 'workspace',
    params: PipelineV2DescribeParams,
    handler: async (input, ctx) => {
      assertPipelineV2Runtime(ctx, input.expectedRuntimeId)
      if (!input.id) {
        if (input.stageId || input.invocationId) {
          throw new Error('pipeline_run_required')
        }
        if (input.projectId) {
          assertPipelineV2Project(ctx, input.projectId, input.expectedRuntimeId)
        }
        return {
          contractVersion: 2 as const,
          version: 2,
          ...(input.projectId
            ? {
                configuredChecks: z
                  .array(PipelineCheck)
                  .max(16)
                  .parse(await ctx.runtime.pipelineRuntime.store.configuredChecks(input.projectId))
                  .map((check) => ({ id: check.id }))
              }
            : {}),
          ownerResolution: 'native-ipc-only',
          controlSchema: z.toJSONSchema(PipelineV2ControlParams),
          statusSchema: z.toJSONSchema(PipelineV2StatusResult),
          policy: {
            create: 'existing reviewed project grants only',
            submission: 'attested active invocation only',
            chatResult:
              'runtime collects the exact completed task turn; no agent CLI or worker_done',
            terminalResult: 'attested CLI submission and worker completion',
            legacyResult: 'existing active launch receipts retain their original protocol',
            publish: 'native owner only',
            budget: 'proposal then native owner confirmation',
            resume: 'pause only; never accepts owner gates',
            review:
              'review evidence does not imply independence; each completion requirement explicitly selects independent and freshSession; absent fields retain legacy true/true semantics',
            resultDiagnostics:
              'currentInvocation.responseObservation retains exact send/root-turn identity, bounded raw response, digest and validation errors; unknown effects remain held',
            resultNormalization:
              'only evidence annotations verification/commit/notes/explanation move losslessly to explanation; outcomes and findings are never inferred or removed'
          },
          bounds: {
            stages: 32,
            outcomes: 8,
            instructions: 6000,
            definitionBytes: 262144,
            templateInputFileBytes: 327680,
            task: 12000,
            result: 12000,
            evidence: 4000,
            context: 16000,
            stagePrompt: 48000,
            page: 50
          },
          postconditions:
            'Mutations require expected runtime, project, workspace instance, revision and request identity. Owner requests never resolve themselves. Read the exact receipt; do not repeat uncertain effects.'
        }
      }
      const run = await scopedPipelineV2(ctx, { ...input, id: input.id })
      const invocation = input.invocationId
        ? run.invocations.find((value) => value.id === input.invocationId)
        : undefined
      if (input.invocationId && !invocation) {
        throw new Error('pipeline_invocation_conflict')
      }
      const stage = run.definition.stages.find(
        (value) => value.id === (input.stageId ?? invocation?.stageId ?? run.stageId)
      )
      if (!stage) {
        throw new Error('pipeline_invalid_stage')
      }
      if (invocation && invocation.stageId !== stage.id) {
        throw new Error('pipeline_stage_invocation_conflict')
      }
      const submit = pipelineV2MandatoryContext(run.definition, stage, '', {
        runId: run.id,
        revision: run.revision,
        expectedInstanceId: run.workspace.instanceId,
        sourceRevision: invocation?.sourceRevision ?? run.sourceRevision,
        ...(invocation
          ? {
              invocation: {
                id: invocation.id,
                dispatchId: invocation.dispatchId,
                inputRevision: invocation.inputRevision,
                sourceRevision: invocation.sourceRevision,
                reviewCommit: invocation.reviewCommit
              }
            }
          : {})
      }).submit
      return {
        contractVersion: 2 as const,
        version: 2,
        ownerResolution: 'native-ipc-only',
        runId: run.id,
        stage,
        submitSchema: pipelineV2SubmitSchema(stage),
        submitExample: submit.example,
        activeBindingRequired: true
      }
    }
  }),
  defineMethod({
    name: 'pipeline.v2.events',
    permission: 'workspace',
    params: PipelineV2EventsParams,
    handler: async (input, ctx) => {
      const run = await scopedPipelineV2(ctx, input)
      return {
        contractVersion: 2 as const,
        ...(await pipelineV2Events(ctx.runtime.pipelineRuntime.store, {
          id: run.id,
          projectId: run.workspace.projectId,
          workspaceId: run.workspace.id,
          instanceId: run.workspace.instanceId,
          cursor: input.cursor,
          limit: input.limit
        }))
      }
    }
  })
]
