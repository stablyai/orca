import type {
  TextSubscriptionAttempt,
  TextSubscriptionFailover
} from './text-subscription-failover'
import type {
  LocalGenerationRequest,
  TextGenerationRequest
} from './source-control-generation-lanes'
import type { AgentSessionUnavailable } from '../../shared/agent-session/agent-session-availability'
import type { spawnProcess } from '@orca/process-host'
import type { AgentGenerationFailureOutput } from './agent-failure-output'
import type {
  CommitMessageAgentCapability,
  CommitMessageModelCapability
} from '../../shared/commit-message-agent-spec'
import type { CommitMessagePlan } from '../../shared/commit-message-plan'
import type { TextGenerationFailureFields } from '../../shared/text-generation-failure-copy'

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

export type CommitMessageGenerationTarget =
  | {
      kind: 'local'
      cwd: string
      env?: NodeJS.ProcessEnv
      wslDistro?: string
      generationRequest?: LocalGenerationRequest
      request?: TextGenerationRequest
      subscription?: TextSubscriptionFailover
      accountAttempt?: TextSubscriptionAttempt
    }
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
      subscriptionQuotaRefused?: boolean
      subscriptionQuotaDiagnostic?: boolean
      /** The prepared account stopped being valid before spawn; failover skips it, not a user cancel. */
      subscriptionAccountChanged?: boolean
      subscriptionRecovery?: {
        attemptedCount: number
        reason:
          | 'no-eligible-alternate'
          | 'attempt-limit'
          | 'exhausted'
          | 'non-quota-failure'
          | 'budget-ended'
        firstError: string
        firstErrorCode?: string
      }
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

export type SpawnedSourceControlAgentProcess = ReturnType<typeof spawnProcess> & {
  /** True when the child is the POSIX provider supervisor: SIGTERM stops the agent's group, then itself. */
  readonly supervised?: boolean
  /** Settles once the post-exit orphan-group sweep has run (or nothing was guarded). */
  readonly groupSwept?: Promise<void>
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
  stdinMode: 'ignore' | 'pipe'
  useCwdForNative: boolean
}

export type SpawnSourceControlAgent = (
  input: SourceControlAgentSpawnInput
) => SpawnedSourceControlAgentProcess

export type LocalSourceControlPlanInput = {
  plan: CommitMessagePlan
  cwd: string
  env: NodeJS.ProcessEnv | undefined
  operation: TextGenerationOperation
  wslDistro?: string
  spawnAgent: SpawnSourceControlAgent
  generationRequest?: LocalGenerationRequest
  request?: TextGenerationRequest
  timeoutMs?: number
}
