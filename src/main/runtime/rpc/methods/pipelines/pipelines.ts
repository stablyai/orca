import * as z from 'zod'
import { defineMethod, type RpcContext } from '../../core'
import {
  PipelineRunParams as runParams,
  PipelineControlParams as controlParams,
  PipelineSubmitParams as submitParams,
  PipelineConfigureParams,
  PipelineReceiptParams,
  PipelineContextParams,
  PipelineReconcileParams
} from '../../../../../shared/rpc-contract/pipeline-params'
import type { PipelineRun } from '../../../../../shared/pipelines/pipeline-contracts'
import { availablePipelines } from '../../../pipelines/pipeline-profiles'
import { pipelineSourceRevision } from '../../../pipelines/pipeline-evidence'
import { PipelineStageEvidence } from '../../../../../shared/pipelines/pipeline-stage-evidence'
import {
  PipelinePublicResultSchemas,
  PipelineRunSummary,
  PipelineContextResponse
} from '../../../../../shared/pipelines/pipeline-public-results'

function summary(run: PipelineRun) {
  const { task: _task, artifacts, checkSnapshot: _checks, profile, ...metadata } = run
  return PipelineRunSummary.parse({
    ...metadata,
    profile: { id: profile.id, title: profile.title, version: profile.version },
    artifactCount: artifacts.length
  })
}

function assertRuntime(ctx: RpcContext, expected?: string): void {
  if (expected && ctx.runtime.getRuntimeId() !== expected) {
    throw new Error('pipeline_runtime_identity_changed')
  }
}

import { callerDispatch } from './pipeline-caller-dispatch'
import { PIPELINE_V2_WORKER_METHODS } from './pipeline-v2-worker-methods'
import { PIPELINE_V2_METHODS } from './pipelines-v2'

export const PIPELINE_METHODS = [
  ...PIPELINE_V2_METHODS,
  ...PIPELINE_V2_WORKER_METHODS,
  defineMethod({
    name: 'pipeline.revalidate',
    permission: 'host-admin',
    params: controlParams,
    handler: async ({ id, expectedRuntimeId, ...mutation }, ctx) => {
      assertRuntime(ctx, expectedRuntimeId)
      const service = ctx.runtime.pipelineRuntime
      await service.assertWorkspace((await service.store.get(id)).workspace)
      const run = await service.store.command(id, { ...mutation, command: { kind: 'revalidate' } })
      service.wake()
      return { run: summary(run) }
    }
  }),
  defineMethod({
    name: 'pipeline.receipt',
    permission: 'workspace',
    params: PipelineReceiptParams,
    handler: async ({ id, kind, expectedRuntimeId, ...mutation }, ctx) => {
      assertRuntime(ctx, expectedRuntimeId)
      const run = await ctx.runtime.pipelineRuntime.store.replay(id, {
        ...mutation,
        command: { kind }
      })
      return { run: run ? summary(run) : null }
    }
  }),
  defineMethod({
    name: 'pipeline.list',
    permission: 'workspace',
    params: null,
    handler: async (_params, { runtime }) => ({
      runs: (await runtime.pipelineRuntime.store.list()).map(summary)
    })
  }),
  defineMethod({
    name: 'pipeline.profiles',
    permission: 'workspace',
    params: null,
    handler: async () => ({ profiles: await availablePipelines() })
  }),
  defineMethod({
    name: 'pipeline.describe',
    permission: 'workspace',
    params: null,
    handler: () => ({
      version: 1,
      stages: ['plan', 'implement', 'checks', 'docs', 'review', 'fix'],
      maxFixCycles: 2,
      submitSchema: z.toJSONSchema(submitParams),
      stageEvidenceSchema: z.toJSONSchema(PipelineStageEvidence),
      controlSchema: z.toJSONSchema(controlParams),
      resultSchemas: PipelinePublicResultSchemas,
      policy: {
        submit: 'attested active worker only',
        pause: 'workspace',
        resume: 'host-admin',
        configure: 'host-admin',
        checks: 'literal argv; project owner configuration; snapshot per run'
      },
      bounds: { task: 12000, artifact: 12000, context: 16000, list: 50 },
      postconditions:
        'Read status after a mutation. Reuse requestId for identical retry. Unknown launch requires reconciliation; never launch again blindly.'
    })
  }),
  defineMethod({
    name: 'pipeline.status',
    permission: 'workspace',
    params: runParams,
    handler: async ({ id }, { runtime }) => {
      const run = await runtime.pipelineRuntime.store.get(id)
      await runtime.pipelineRuntime.assertWorkspace(run.workspace)
      const sourceRevision = await pipelineSourceRevision(run.workspace).catch(() => null)
      return {
        run: summary(run),
        sourceRevision,
        currentEvidence: sourceRevision !== null && run.checkedRevision === sourceRevision,
        ready:
          sourceRevision !== null &&
          run.state === 'ready_for_review' &&
          run.checkedRevision === sourceRevision,
        sourceAvailable: sourceRevision !== null
      }
    }
  }),
  defineMethod({
    name: 'pipeline.context',
    permission: 'workspace',
    params: PipelineContextParams,
    handler: async ({ id, artifactStage, artifactIndex }, { runtime }) => {
      const service = runtime.pipelineRuntime
      const run = await service.store.get(id)
      await service.assertWorkspace(run.workspace)
      return PipelineContextResponse.parse({
        ...(await service.store.context(id, run.stage, artifactStage, artifactIndex)),
        active: run.active,
        sourceRevision: await pipelineSourceRevision(run.workspace)
      })
    }
  }),
  defineMethod({
    name: 'pipeline.submit',
    permission: 'workspace',
    params: submitParams,
    handler: async ({ id, mutation }, ctx) => {
      const service = ctx.runtime.pipelineRuntime
      await service.assertWorkspace((await service.store.get(id)).workspace)
      const run = await service.controller.submit(
        id,
        mutation,
        await callerDispatch(ctx, (await service.store.get(id)).workspace.id)
      )
      service.wake()
      return { run: summary(run) }
    }
  }),
  defineMethod({
    name: 'pipeline.pause',
    permission: 'workspace',
    params: controlParams,
    handler: async ({ id, expectedRuntimeId, ...mutation }, ctx) => {
      assertRuntime(ctx, expectedRuntimeId)
      return {
        run: summary(
          await ctx.runtime.pipelineRuntime.store.command(id, {
            ...mutation,
            command: { kind: 'pause' }
          })
        )
      }
    }
  }),
  defineMethod({
    name: 'pipeline.resume',
    permission: 'host-admin',
    params: controlParams,
    handler: async ({ id, expectedRuntimeId, ...mutation }, ctx) => {
      assertRuntime(ctx, expectedRuntimeId)
      const { runtime } = ctx
      const service = runtime.pipelineRuntime
      const current = await service.store.get(id)
      await service.assertWorkspace(current.workspace)
      if (
        !(await availablePipelines()).some(
          (row) =>
            row.digest === current.definitionDigest &&
            row.provider.pluginKey === current.provider?.pluginKey &&
            row.provider.fingerprint === current.provider?.fingerprint
        )
      ) {
        throw new Error('pipeline_profile_unavailable_or_changed')
      }
      const run = await service.store.command(id, { ...mutation, command: { kind: 'resume' } })
      service.wake()
      return { run: summary(run) }
    }
  }),
  defineMethod({
    name: 'pipeline.reconcile',
    permission: 'host-admin',
    params: PipelineReconcileParams,
    handler: async ({ id, setupTerminal }, { runtime }) => {
      if (setupTerminal) {
        const run = await runtime.pipelineRuntime.store.get(id)
        await runtime.pipelineRuntime.assertWorkspace(run.workspace)
        const terminal = await runtime.showTerminal(setupTerminal)
        if (terminal.worktreeId !== run.workspace.id) {
          throw new Error('pipeline_setup_workspace_mismatch')
        }
        await runtime.pipelineRuntime.store.command(id, {
          requestId: `reconcile-setup:${id}:${run.revision}`,
          expectedRevision: run.revision,
          command: { kind: 'setup_wait', terminalHandle: setupTerminal }
        })
        runtime.pipelineRuntime.observeSetup(id, setupTerminal)
      }
      await runtime.pipelineRuntime.controller.reconcile(id)
      return { run: summary(await runtime.pipelineRuntime.store.get(id)) }
    }
  }),
  defineMethod({
    name: 'pipeline.configure',
    permission: 'host-admin',
    params: PipelineConfigureParams,
    handler: async ({ projectId, checks }, { runtime }) => {
      await runtime.pipelineRuntime.store.configureChecks(projectId, checks)
      return { projectId, checks }
    }
  })
]
