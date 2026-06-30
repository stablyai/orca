import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalBoolean, OptionalFiniteNumber, OptionalString, requiredString } from '../schemas'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import type {
  PipelineRecoveryReportStatus,
  PipelineRunInput,
  PipelineRunStatus
} from '../../../../shared/pipelines-types'

const PipelineTuiAgent = requiredString('Missing agent id').refine(isTuiAgent, {
  message: 'Unknown provider'
})

const PipelineTaskSource = z.object({
  type: z.literal('github_issues'),
  provider: z.literal('github'),
  owner: requiredString('Missing GitHub owner'),
  repo: requiredString('Missing GitHub repo'),
  prdIssueNumber: z.number().int().positive(),
  pipelinePrdLabel: requiredString('Missing Pipeline PRD label'),
  state: z.literal('open')
})

const PipelineVerifier = z.object({
  commands: z.array(z.string()),
  timeoutSeconds: z.number().int().positive()
})

export const PipelineRunParams = z.object({
  templateId: requiredString('Missing templateId'),
  repoId: requiredString('Missing repoId'),
  sourceBranch: requiredString('Missing sourceBranch'),
  targetBranch: requiredString('Missing targetBranch'),
  taskSource: PipelineTaskSource,
  maxConcurrent: z.number().int().positive(),
  maxIterations: z.number().int().positive().optional(),
  plannerAgentId: PipelineTuiAgent,
  implementerAgentId: PipelineTuiAgent,
  reviewerAgentId: PipelineTuiAgent.optional(),
  mergerAgentId: PipelineTuiAgent,
  verifier: PipelineVerifier.optional(),
  executionTargetType: z.enum(['local', 'ssh']),
  executionTargetId: OptionalString
})

const PipelineTemplateListParams = z.object({
  includeBuiltIn: OptionalBoolean
})

const PipelineListParams = z.object({
  repoId: OptionalString,
  status: z
    .enum([
      'pending',
      'planning',
      'dispatching',
      'executing',
      'reviewing',
      'merging',
      'verifying',
      'completed',
      'failed',
      'cancelled',
      'interrupted'
    ])
    .optional(),
  limit: OptionalFiniteNumber
})

const PipelineRunIdParams = z.object({
  runId: requiredString('Missing runId')
})

const PipelineCancelParams = PipelineRunIdParams.extend({
  preserveWorktrees: OptionalBoolean
})

const PipelineLogsParams = PipelineRunIdParams.extend({
  stageId: OptionalString,
  taskId: OptionalString,
  limit: OptionalFiniteNumber
})

const PipelineReleaseStaleReservationParams = z.object({
  reservationId: requiredString('Missing reservationId'),
  confirm: z.literal(true)
})

const PipelinePrdCandidatesParams = z.object({
  repoId: requiredString('Missing repoId'),
  owner: requiredString('Missing GitHub owner'),
  repo: requiredString('Missing GitHub repo'),
  limit: OptionalFiniteNumber,
  since: OptionalString
})

const PipelineRecoveryReportListParams = z.object({
  repoId: OptionalString,
  prdIssueNumber: z.number().int().positive().optional(),
  status: z.enum(['pending_ack', 'acknowledged']).optional()
})

const PipelineRecoveryReportAcknowledgeParams = z.object({
  reportId: requiredString('Missing reportId')
})

export const PIPELINE_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'pipelines.templateList',
    params: PipelineTemplateListParams,
    handler: (_params, { runtime }) => runtime.getPipelineService().templateList()
  }),
  defineMethod({
    name: 'pipelines.run',
    params: PipelineRunParams,
    handler: (params, { runtime }) => runtime.getPipelineService().run(params as PipelineRunInput)
  }),
  defineMethod({
    name: 'pipelines.list',
    params: PipelineListParams,
    handler: (params, { runtime }) =>
      runtime.getPipelineService().list({
        repoId: params.repoId,
        status: params.status as PipelineRunStatus | undefined,
        limit: params.limit
      })
  }),
  defineMethod({
    name: 'pipelines.show',
    params: PipelineRunIdParams,
    handler: (params, { runtime }) => runtime.getPipelineService().show(params.runId)
  }),
  defineMethod({
    name: 'pipelines.cancel',
    params: PipelineCancelParams,
    handler: (params, { runtime }) => runtime.getPipelineService().cancel(params.runId)
  }),
  defineMethod({
    name: 'pipelines.logs',
    params: PipelineLogsParams,
    handler: (params, { runtime }) =>
      runtime.getPipelineService().logs({
        runId: params.runId,
        stageId: params.stageId,
        taskId: params.taskId,
        limit: params.limit
      })
  }),
  defineMethod({
    name: 'pipelines.releaseStaleReservation',
    params: PipelineReleaseStaleReservationParams,
    handler: (params, { runtime }) => runtime.getPipelineService().releaseStaleReservation(params)
  }),
  defineMethod({
    name: 'pipelines.prdCandidates',
    params: PipelinePrdCandidatesParams,
    handler: (params, { runtime }) => runtime.getPipelineService().prdCandidates(params)
  }),
  defineMethod({
    name: 'pipelines.recoveryReportList',
    params: PipelineRecoveryReportListParams,
    handler: (params, { runtime }) =>
      runtime.getPipelineService().recoveryReportList({
        repoId: params.repoId,
        prdIssueNumber: params.prdIssueNumber,
        status: params.status as PipelineRecoveryReportStatus | undefined
      })
  }),
  defineMethod({
    name: 'pipelines.recoveryReportAcknowledge',
    params: PipelineRecoveryReportAcknowledgeParams,
    handler: (params, { runtime }) =>
      runtime.getPipelineService().recoveryReportAcknowledge(params.reportId)
  })
]
