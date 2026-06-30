import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRequiredPositiveIntegerFlag,
  getRequiredStringFlag
} from '../flags'
import { RuntimeClientError } from '../runtime-client'
import { derivePipelinePrdLabel } from '../../shared/pipeline-prd-work-set'
import type { PipelineRunInput, PipelineRunStatus } from '../../shared/pipelines-types'

export const PIPELINE_HANDLERS: Record<string, CommandHandler> = {
  'pipelines template-list': async ({ client, json }) => {
    const result = await client.call('pipelines.templateList', {})
    printResult(result, json, () => JSON.stringify(result, null, 2))
  },

  'pipelines run': async ({ flags, client, json }) => {
    const input = buildPipelineRunInput(flags)
    const result = await client.call<{ run: { id: string; status: string } }>(
      'pipelines.run',
      input
    )
    printResult(result, json, (r) => `Created ${r.run.id} [${r.run.status}]`)
  },

  'pipelines list': async ({ flags, client, json }) => {
    const result = await client.call('pipelines.list', {
      repoId: getOptionalStringFlag(flags, 'repo'),
      status: getOptionalStringFlag(flags, 'status') as PipelineRunStatus | undefined,
      limit: getOptionalPositiveIntegerFlag(flags, 'limit')
    })
    printResult(result, json, () => JSON.stringify(result, null, 2))
  },

  'pipelines show': async ({ flags, client, json }) => {
    const result = await client.call('pipelines.show', {
      runId: getRequiredStringFlag(flags, 'run')
    })
    printResult(result, json, () => JSON.stringify(result, null, 2))
  },

  'pipelines cancel': async ({ flags, client, json }) => {
    const result = await client.call<{ run: { id: string; status: string } }>('pipelines.cancel', {
      runId: getRequiredStringFlag(flags, 'run'),
      preserveWorktrees: flags.has('preserve-worktrees') ? true : undefined
    })
    printResult(result, json, (r) => `Cancelled ${r.run.id} [${r.run.status}]`)
  },

  'pipelines logs': async ({ flags, client, json }) => {
    const result = await client.call('pipelines.logs', {
      runId: getRequiredStringFlag(flags, 'run'),
      stageId: getOptionalStringFlag(flags, 'stage'),
      taskId: getOptionalStringFlag(flags, 'task'),
      limit: getOptionalPositiveIntegerFlag(flags, 'limit')
    })
    printResult(result, json, () => JSON.stringify(result, null, 2))
  },

  'pipelines release-stale-reservation': async ({ flags, client, json }) => {
    const result = await client.call('pipelines.releaseStaleReservation', {
      reservationId: getRequiredStringFlag(flags, 'reservation'),
      confirm: requireConfirmFlag(flags)
    })
    printResult(result, json, () => JSON.stringify(result, null, 2))
  },

  'pipelines recovery-reports': async ({ flags, client, json }) => {
    const result = await client.call('pipelines.recoveryReportList', {
      repoId: getOptionalStringFlag(flags, 'repo'),
      prdIssueNumber: getOptionalPositiveIntegerFlag(flags, 'prd-issue'),
      status: getOptionalStringFlag(flags, 'status')
    })
    printResult(result, json, () => JSON.stringify(result, null, 2))
  },

  'pipelines recovery-report-acknowledge': async ({ flags, client, json }) => {
    const result = await client.call('pipelines.recoveryReportAcknowledge', {
      reportId: getRequiredStringFlag(flags, 'report')
    })
    printResult(result, json, () => JSON.stringify(result, null, 2))
  }
}

export function buildPipelineRunInput(flags: Map<string, string | boolean>): PipelineRunInput {
  return {
    templateId: getRequiredStringFlag(flags, 'template'),
    repoId: getRequiredStringFlag(flags, 'repo'),
    sourceBranch: getRequiredStringFlag(flags, 'source-branch'),
    targetBranch: getRequiredStringFlag(flags, 'target-branch'),
    taskSource: buildTaskSource(flags),
    maxConcurrent: getMaxConcurrent(flags),
    maxIterations: getOptionalPositiveIntegerFlag(flags, 'max-iterations'),
    plannerAgentId: getRequiredStringFlag(
      flags,
      'planner-agent'
    ) as PipelineRunInput['plannerAgentId'],
    implementerAgentId: getRequiredStringFlag(
      flags,
      'implementer-agent'
    ) as PipelineRunInput['implementerAgentId'],
    reviewerAgentId: getOptionalStringFlag(flags, 'reviewer-agent') as
      | PipelineRunInput['reviewerAgentId']
      | undefined,
    mergerAgentId: getRequiredStringFlag(
      flags,
      'merger-agent'
    ) as PipelineRunInput['mergerAgentId'],
    verifier: buildVerifier(flags),
    executionTargetType: getExecutionTargetType(flags),
    executionTargetId: getOptionalStringFlag(flags, 'execution-target-id')
  }
}

function buildTaskSource(flags: Map<string, string | boolean>): PipelineRunInput['taskSource'] {
  const type = getRequiredStringFlag(flags, 'task-source')
  if (type === 'github') {
    const prdIssueNumber = getRequiredPositiveIntegerFlag(flags, 'prd-issue')
    return {
      type: 'github_issues',
      provider: 'github',
      owner: getRequiredStringFlag(flags, 'task-owner'),
      repo: getRequiredStringFlag(flags, 'task-repo'),
      prdIssueNumber,
      pipelinePrdLabel: derivePipelinePrdLabel(prdIssueNumber),
      state: 'open'
    }
  }
  throw new RuntimeClientError('invalid_argument', '--task-source must be github')
}

function getMaxConcurrent(flags: Map<string, string | boolean>): number {
  if (getRequiredStringFlag(flags, 'template') === 'sequential-reviewer') {
    return 1
  }
  return getOptionalPositiveIntegerFlag(flags, 'max-concurrent') ?? 1
}

function buildVerifier(flags: Map<string, string | boolean>): PipelineRunInput['verifier'] {
  const command = getOptionalStringFlag(flags, 'verify-command')
  if (!command) {
    return undefined
  }
  return {
    commands: [command],
    timeoutSeconds: getOptionalPositiveIntegerFlag(flags, 'verify-timeout-seconds') ?? 60
  }
}

function getExecutionTargetType(flags: Map<string, string | boolean>): 'local' | 'ssh' {
  const value = getOptionalStringFlag(flags, 'execution-target-type') ?? 'local'
  if (value === 'local' || value === 'ssh') {
    return value
  }
  throw new RuntimeClientError('invalid_argument', '--execution-target-type must be local or ssh')
}

function requireConfirmFlag(flags: Map<string, string | boolean>): true {
  if (flags.get('confirm') !== true) {
    throw new RuntimeClientError('invalid_argument', '--confirm is required')
  }
  return true
}
