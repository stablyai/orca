import type { spawnProcess } from '../../shared/child-process/run-process'
import type { AgentGenerationFailureOutput } from './agent-failure-output'
import type {
  CommitMessageAgentCapability,
  CommitMessageModelCapability
} from '../../shared/commit-message-agent-spec'
import type { CommitMessagePlan } from '../../shared/commit-message-plan'

export type GenerateCommitMessageResult =
  | { success: true; message: string; agentLabel?: string }
  | { success: false; error: string; canceled?: boolean }

export type DiscoverCommitMessageModelsResult =
  | {
      success: true
      capability: CommitMessageAgentCapability
      models: CommitMessageModelCapability[]
      defaultModelId: string
      catalogOrigin: 'probe' | 'spec'
    }
  | { success: false; error: string }

export type GeneratePullRequestFieldsResult<TFields> =
  | {
      success: true
      fields: TFields
      agentLabel?: string
      branchChangedByPreparation?: boolean
    }
  | { success: false; error: string; canceled?: boolean; branchChangedByPreparation?: boolean }

export type RemoteCommitMessageExecResult = {
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
  canceled?: boolean
  spawnError?: string
}

export type TextGenerationOperation = 'commit-message' | 'pull-request-fields' | 'branch-name'

export type CommitMessageGenerationTarget =
  | { kind: 'local'; cwd: string; env?: NodeJS.ProcessEnv; wslDistro?: string }
  | {
      kind: 'remote'
      cwd: string
      execute: (
        plan: CommitMessagePlan,
        cwd: string,
        timeoutMs: number,
        operation: TextGenerationOperation
      ) => Promise<RemoteCommitMessageExecResult>
      missingBinaryLocation: string
    }

export type InternalTextGenerationResult =
  | { success: true; rawOutput: string; agentLabel?: string }
  | {
      success: false
      error: string
      canceled?: boolean
      failureOutput?: AgentGenerationFailureOutput
    }

export type GenerateBranchNameResult =
  | { success: true; slug: string; agentLabel?: string }
  | {
      success: false
      error: string
      canceled?: boolean
      failureOutput?: AgentGenerationFailureOutput
    }

export type LocalProcessExecution<T> = {
  result: Promise<T>
  processClosed: Promise<void>
}

export type SpawnedSourceControlAgentProcess = ReturnType<typeof spawnProcess>

export type LocalGenerationTarget = Extract<CommitMessageGenerationTarget, { kind: 'local' }>
export type RemoteGenerationTarget = Extract<CommitMessageGenerationTarget, { kind: 'remote' }>

export type SpawnSourceControlAgent = (input: {
  binary: string
  args: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  wslDistro?: string
  stdinMode: 'ignore' | 'pipe'
  useCwdForNative: boolean
}) => SpawnedSourceControlAgentProcess
