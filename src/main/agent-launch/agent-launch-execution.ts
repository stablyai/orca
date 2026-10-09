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
import type { AgentLaunchModeReceipt, AgentLaunchModeVocabulary } from './agent-launch-mode'
import type {
  AgentLaunchSurfaceFactory,
  AgentLaunchWorkspaceFactory
} from './agent-launch-surface-factories'

/**
 * The launch as it stands once its surface exists: a complete result whose prompt receipt says only
 * what creation itself settled — carried on the launch command, a draft the host never delivers, or
 * a submit still `unconfirmed`. Complete so a host that dies during the delivery still leaves a
 * truthful answer behind.
 */
export type AgentLaunchPublishedSurface = AgentLaunchResult

type AgentLaunchExecutionBase = {
  runtime: Pick<OrcaRuntimeService, 'getStructuredAgentSessionCreateSupport' | 'getClientSettings'>
  vocabulary?: AgentLaunchModeVocabulary
  /** False when the calling client cannot show the agent's chat; absent for the host's own callers. */
  callerRendersStructured?: boolean
  /** Attributes a throw to the step that was running, the way a dispatch's own stages do. */
  onStage?: (stage: 'worktree_create' | 'mode_settle' | 'surface_create') => void
  /** The surface exists and its tab is published; runs before any prompt delivery. Must not throw. */
  onSurfacePublished?: (surface: AgentLaunchPublishedSurface) => void
}

/** Every launch but a `legacy-host` create: it builds the surface itself when the create gave none. */
export type AgentLaunchSurfaceExecution = AgentLaunchExecutionBase & {
  intent: AgentLaunchIntent
  surfaces: AgentLaunchSurfaceFactory
  workspaces?: AgentLaunchWorkspaceFactory
  /** Host-internal, never on the wire: settles a terminal agent whatever the chat default says, for
   *  a caller whose contract is a terminal handle. */
  terminalOnly?: boolean
  /** The launch's own delivery: argv only when the typed line carries it, else a paste. */
  promptPolicy?: undefined
} & (
    | { decidedMode?: undefined }
    | {
        /** Host-internal: the pre-flight a caller decided itself because it records the receipt
         *  before the launch runs (an orchestration dispatch). For an existing workspace it must
         *  already carry that host's answer; the executor asks the host only about a workspace it
         *  creates. It replaces the pre-flight, so `terminalOnly` and `callerRendersStructured` are
         *  refused. Temporary until one planner settles every launch. */
        decidedMode: AgentLaunchModeReceipt
        terminalOnly?: never
        callerRendersStructured?: never
      }
  )

/**
 * Host-internal, never on the wire. `legacy-host` is `worktree.create`'s own delivery, kept for the
 * host's legacy producers: the create folds a submit into the command at any length (the
 * shell-ready staging carries long lines), sends it once a post-start agent is up, and pastes a
 * draft unsent. Only a terminal create has the startup terminal that delivery needs, and that
 * terminal is the launch's only surface.
 */
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
