import { defineMethod } from '../core'
import { getWorkflowController } from '../../../workflows/workflow-controller-registry'
import { computeWorkflowMetrics } from '../../../../shared/workflow/workflow-metrics'
import { WorkflowValidationError } from '../../../workflows/workflow-request-error'
import type { WorkflowRun } from '../../../../shared/workflow/workflow-run-types'
import {
  WorkflowApprovalResolveParams,
  WorkflowMessageReleaseParams,
  WorkflowPresetIdParams,
  WorkflowPresetSaveParams,
  WorkflowQuestionReplyParams,
  WorkflowRunGetParams,
  WorkflowRunIdParams,
  WorkflowRunListParams,
  WorkflowRunStartParams,
  WorkflowTaskRetryParams,
  WorkflowValidateParams
} from '../../../../shared/rpc-contract/workflow-params'

function runSummary(run: WorkflowRun) {
  return {
    id: run.id,
    presetId: run.presetId,
    presetName: run.presetName,
    objective: run.objective.slice(0, 240),
    status: run.status,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    settledAt: run.settledAt,
    error: run.error
  }
}

export const WORKFLOW_METHODS = [
  defineMethod({
    name: 'workflow.presetList',
    permission: 'workspace',
    params: null,
    handler: (_params, { runtime }) => {
      const controller = getWorkflowController(runtime)
      return {
        presets: controller.store.listPresets().map((preset) => ({
          ...preset,
          template: controller.store.isTemplate(preset.id)
        }))
      }
    }
  }),
  defineMethod({
    name: 'workflow.presetSave',
    permission: 'workspace',
    params: WorkflowPresetSaveParams,
    handler: async (params, { runtime }) => ({
      preset: await getWorkflowController(runtime).savePreset(params.preset)
    })
  }),
  defineMethod({
    name: 'workflow.presetDelete',
    permission: 'workspace',
    params: WorkflowPresetIdParams,
    handler: async (params, { runtime }) => ({
      deleted: await getWorkflowController(runtime).store.deletePreset(params.id)
    })
  }),
  defineMethod({
    name: 'workflow.validate',
    permission: 'workspace',
    params: WorkflowValidateParams,
    handler: async (params, { runtime }) => {
      const { issues } = await getWorkflowController(runtime).validate(params.definition)
      return { issues }
    }
  }),
  defineMethod({
    name: 'workflow.runStart',
    permission: 'workspace',
    params: WorkflowRunStartParams,
    handler: async (params, { runtime }) => {
      try {
        return {
          run: runSummary(await getWorkflowController(runtime).startRun(params)),
          issues: []
        }
      } catch (error) {
        // Validation refusals return their issues so the editor can point at each node.
        if (error instanceof WorkflowValidationError) {
          return { run: null, issues: error.issues }
        }
        throw error
      }
    }
  }),
  defineMethod({
    name: 'workflow.runList',
    permission: 'workspace',
    params: WorkflowRunListParams,
    handler: (params, { runtime }) => ({
      runs: getWorkflowController(runtime)
        .store.listRuns()
        .filter((run) => !params.presetId || run.presetId === params.presetId)
        .map(runSummary)
    })
  }),
  defineMethod({
    name: 'workflow.runGet',
    permission: 'workspace',
    params: WorkflowRunGetParams,
    handler: (params, { runtime }) => {
      const run = getWorkflowController(runtime).store.getRun(params.id)
      if (!run) {
        throw new Error(`Workflow run ${params.id} was not found.`)
      }
      const after = params.afterSeq ?? -1
      return {
        run: { ...run, events: run.events.filter((event) => event.seq > after) },
        metrics: computeWorkflowMetrics(run)
      }
    }
  }),
  defineMethod({
    name: 'workflow.runPause',
    permission: 'workspace',
    params: WorkflowRunIdParams,
    handler: async (params, { runtime }) => {
      await getWorkflowController(runtime).pause(params.id)
      return { ok: true }
    }
  }),
  defineMethod({
    name: 'workflow.runResume',
    permission: 'workspace',
    params: WorkflowRunIdParams,
    handler: async (params, { runtime }) => {
      await getWorkflowController(runtime).resume(params.id)
      return { ok: true }
    }
  }),
  defineMethod({
    name: 'workflow.runCancel',
    permission: 'workspace',
    params: WorkflowRunIdParams,
    handler: async (params, { runtime }) => {
      await getWorkflowController(runtime).cancel(params.id)
      return { ok: true }
    }
  }),
  defineMethod({
    name: 'workflow.runDelete',
    permission: 'workspace',
    params: WorkflowRunIdParams,
    handler: (params, { runtime }) => ({
      deleted: getWorkflowController(runtime).deleteRun(params.id)
    })
  }),
  defineMethod({
    name: 'workflow.taskRetry',
    permission: 'workspace',
    params: WorkflowTaskRetryParams,
    handler: async (params, { runtime }) => {
      await getWorkflowController(runtime).retryTask(params.runId, params.taskKey)
      return { ok: true }
    }
  }),
  defineMethod({
    name: 'workflow.approvalResolve',
    permission: 'workspace',
    params: WorkflowApprovalResolveParams,
    handler: async (params, { runtime }) => {
      await getWorkflowController(runtime).resolveApproval(
        params.runId,
        params.taskKey,
        params.resolution
      )
      return { ok: true }
    }
  }),
  defineMethod({
    name: 'workflow.messageRelease',
    permission: 'workspace',
    params: WorkflowMessageReleaseParams,
    handler: async (params, { runtime }) => {
      await getWorkflowController(runtime).releaseMessage(
        params.runId,
        params.messageId,
        params.decision
      )
      return { ok: true }
    }
  }),
  defineMethod({
    name: 'workflow.questionReply',
    permission: 'workspace',
    params: WorkflowQuestionReplyParams,
    handler: async (params, { runtime }) => {
      await getWorkflowController(runtime).replyToQuestion(
        params.runId,
        params.messageId,
        params.body
      )
      return { ok: true }
    }
  })
]
