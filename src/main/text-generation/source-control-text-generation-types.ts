import type { GenerationArgument } from '../../shared/source-control/ai/generation/generation-argument'
import type { ProviderChild } from '../provider-process/provider-child'
import type { ChildProcess } from 'node:child_process'
import type { EventEmitter } from 'node:events'
import type { AgentSessionUnavailable } from '../../shared/agent-session/failures/agent-session-availability'
import type { AgentGenerationFailureOutput } from './failures/agent-failure-output'
import type {
  CommitMessageAgentCapability,
  CommitMessageModelCapability
} from '../../shared/source-control/ai/generation/commit-message-agent-spec'
import type { CommitMessagePlan } from '../../shared/source-control/ai/generation/commit-message-plan'
import type { TextGenerationFailureFields } from '../../shared/text-generation/text-generation-failure-copy'

export type GenerateCommitMessageResult =
  | { success: true; message: string; agentLabel?: string }
  | ({ success: false; canceled?: boolean } & TextGenerationFailureFields)

export type DiscoverCommitMessageModelsResult =
  | {
      success: true
      capability: CommitMessageAgentCapability
      models: CommitMessageModelCapability[]
      defaultModelId: string
      catalogOrigin: 'probe' | 'spec'
      /** Some providers could not be read. Their saved choices are still valid. */
      partial?: true
    }
  | { success: false; error: string; unavailable?: AgentSessionUnavailable }

export type GeneratePullRequestFieldsResult<TFields> =
  | {
      success: true
      fields: TFields
      agentLabel?: string
      branchChangedByPreparation?: boolean
    }
  | ({
      success: false
      canceled?: boolean
      branchChangedByPreparation?: boolean
    } & TextGenerationFailureFields)

export type RemoteCommitMessageExecResult = {
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
  canceled?: boolean
  spawnError?: string
}

export type TextGenerationOperation =
  | 'commit-message'
  | 'pull-request-fields'
  | 'branch-name'
  | 'jira-issue-summary'
  | 'conversation-name'
  | 'bot-suggestions'
  | 'dictation-cleanup'

export type CommitMessageGenerationTarget =
  | { kind: 'local'; cwd: string; env?: NodeJS.ProcessEnv; wslDistro?: string; laneId?: string }
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
  | ({
      success: false
      canceled?: boolean
      failureOutput?: AgentGenerationFailureOutput
    } & TextGenerationFailureFields)

export type GenerateBranchNameResult =
  | { success: true; slug: string; agentLabel?: string }
  | {
      success: false
      error: string
      canceled?: boolean
      failureOutput?: AgentGenerationFailureOutput
    }

export type GenerateConversationNameResult =
  | { success: true; name: string; agentLabel?: string }
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

export type SpawnedSourceControlAgentProcess = Pick<
  ChildProcess,
  'pid' | 'kill' | 'stdin' | 'stdout' | 'stderr' | 'exitCode' | 'signalCode'
> &
  EventEmitter &
  Pick<ProviderChild, 'leaderExited' | 'ready' | 'outcomeLost'> & {
    /** True when the POSIX lifecycle adapter owns the agent group. */
    readonly supervised?: boolean
  }

export type LocalGenerationTarget = Extract<CommitMessageGenerationTarget, { kind: 'local' }>
export type RemoteGenerationTarget = Extract<CommitMessageGenerationTarget, { kind: 'remote' }>

export type SourceControlAgentSpawnInput = {
  binary: string
  args: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  wslDistro?: string
  // WSL applies these in the guest; native callers already merge them into env.
  commandEnv?: Record<string, string>
  preparation?: { script: string; args: string[] }
  literalArgIndices?: number[]
  stdinMode: 'ignore' | 'pipe'
  useCwdForNative: boolean
}

export type SpawnSourceControlAgent = (
  input: SourceControlAgentSpawnInput
) => SpawnedSourceControlAgentProcess

export type LocalSourceControlPlanInput = {
  plan: CommitMessagePlan<GenerationArgument>
  cwd: string
  env: NodeJS.ProcessEnv | undefined
  operation: TextGenerationOperation
  laneId?: string
  wslDistro?: string
  spawnAgent: SpawnSourceControlAgent
  /** How long the agent may run; the source-control default when absent. */
  timeoutMs?: number
}
