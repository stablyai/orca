import type { OrchestrationDb } from '../runtime/orchestration/db'
import type { PipelineCommitInspector, PipelineVerifyCommandRunner } from './review-merge-verify'
import type { PipelineIteration, PipelineRun } from '../../shared/pipelines-types'
import type { PipelineTemplate } from '../../shared/pipeline-template-types'
import type { TuiAgent } from '../../shared/types'

export type PipelineRuntimeWorktreeInput = {
  repoSelector: string
  name: string
  baseBranch: string
  branchNameOverride: string
  linkedIssue?: number | null
  comment: string
  displayName: string
  telemetrySource: 'pipeline'
  workspaceStatus: string
  lineage?: {
    orchestrationContext?: {
      orchestrationRunId?: string
      coordinatorHandle?: string
    }
  }
}

export type PipelineRuntimeWorktree = {
  id: string
  path: string
}

export type PipelineRuntimeAgentStage = 'planner' | 'review' | 'merge'

export type PipelineRuntimeAgentInput = {
  agentId: TuiAgent
  stage: PipelineRuntimeAgentStage
  run: PipelineRun
  iteration: PipelineIteration
  template: PipelineTemplate
  worktreeId: string
  cwd: string
  prompt: string
  title: string
}

export type PipelineRuntimeAgentResult = {
  terminalId?: string | null
  stdout: string
}

export type PipelineRuntimeAgentTerminalInput = {
  agentId: TuiAgent
  worktreeId: string
  title: string
}

export type PipelineRuntimeCoordinatorResult = {
  status: 'completed' | 'failed' | 'cancelled'
  completedTaskIds: string[]
  failedTaskIds?: string[]
}

export type PipelineRuntimeExecutorAdapter = {
  createWorktree(input: PipelineRuntimeWorktreeInput): Promise<PipelineRuntimeWorktree>
  runAgent(input: PipelineRuntimeAgentInput): Promise<PipelineRuntimeAgentResult>
  createAgentTerminal(
    input: PipelineRuntimeAgentTerminalInput
  ): Promise<{ terminalId: string | null }>
  runCoordinator(input: {
    db: OrchestrationDb
    coordinatorRunId: string
    coordinatorHandle: string
    maxConcurrent: number
  }): Promise<PipelineRuntimeCoordinatorResult>
  inspectCommits: PipelineCommitInspector
  runCommand: PipelineVerifyCommandRunner
}
