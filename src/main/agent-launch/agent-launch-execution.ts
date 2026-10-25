import type { HostFoundingAttempt } from './host-founding-attempt'
/**
 * What a caller hands `executeAgentLaunch`. Two shapes, so the compiler rather than a runtime throw
 * keeps each caller to the inputs its policy needs: a launch that may build its own surface must
 * bring the factory for it, and a `legacy-host` create, whose startup terminal is its only
 * surface, cannot bring one.
 */

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
  hostFoundingAttempt?: HostFoundingAttempt
  /** Best-effort canonical bookkeeping; independent of presentation and ancillary failures. */
  onSurfaceAdmitted?: (surface: AgentLaunchPublishedSurface) => void
  /** Only an installed surface may authorize presentation/selection. Must not throw. */
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
