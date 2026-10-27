import type {
  AgentLaunchIntent,
  AgentLaunchResult,
  AgentLaunchTarget
} from '../../shared/agent-launch-intent'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type {
  readAgentLaunchModeSettings,
  AgentLaunchModeReceipt,
  AgentLaunchModeVocabulary
} from './agent-launch-mode'
import type {
  AgentLaunchSurfaceFactory,
  AgentLaunchWorkspaceFactory
} from './agent-launch-surface-factories'

/** Persist the surface result before delivery so a host crash leaves an honest prompt receipt. */
export type AgentLaunchPublishedSurface = AgentLaunchResult

type AgentLaunchExecutionBase = {
  runtime: Pick<OrcaRuntimeService, 'getStructuredAgentSessionCreateSupport'> &
    Parameters<typeof readAgentLaunchModeSettings>[0]
  vocabulary?: AgentLaunchModeVocabulary
  /** False if the client cannot display this chat; host callers may omit it. */
  callerRendersStructured?: boolean
  onStage?: (stage: 'worktree_create' | 'mode_settle' | 'surface_create') => void
  /** Runs after tab publication, before post-creation delivery; must not throw. */
  onSurfacePublished?: (surface: AgentLaunchPublishedSurface) => void
  /** Abort at the next boundary; return an existing agent and skip pending prompt delivery. */
  signal?: AbortSignal
}

export type AgentLaunchSurfaceExecution = AgentLaunchExecutionBase & {
  intent: AgentLaunchIntent
  surfaces: AgentLaunchSurfaceFactory
  workspaces?: AgentLaunchWorkspaceFactory
  /** Host-only override for callers that require a terminal handle. */
  terminalOnly?: boolean
  promptPolicy?: undefined
} & (
    | { decidedMode?: undefined }
    | {
        /** Host-only preflight receipt; existing-workspace callers must already include the host verdict. */
        decidedMode: AgentLaunchModeReceipt
        terminalOnly?: never
        callerRendersStructured?: never
      }
  )

/** Host-only worktree.create delivery: the startup terminal is the sole surface and owns the prompt. */
export type AgentLaunchLegacyHostExecution = AgentLaunchExecutionBase & {
  intent: AgentLaunchIntent & {
    target: Extract<AgentLaunchTarget, { kind: 'create-worktree' }>
    reuseTerminal?: never
  }
  promptPolicy: 'legacy-host'
  terminalOnly: true
  workspaces: AgentLaunchWorkspaceFactory
  surfaces?: never
  decidedMode?: never
}

export type AgentLaunchExecution = AgentLaunchSurfaceExecution | AgentLaunchLegacyHostExecution
