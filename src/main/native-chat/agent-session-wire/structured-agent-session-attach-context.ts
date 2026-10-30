import type { AttachFlowInput } from './structured-agent-session-attach-flow'
import type { AgentSessionCreatePhaseRecorder } from '../../observability/agent-session-instrumentation'
import type { StructuredAgentSessionAttachLock } from './structured-agent-session-attach-lock'
// What attaching needs from the host, named explicitly.
//
// Passing the host itself would let this quietly grow new dependencies; an explicit context makes
// each one a deliberate addition and keeps the orchestration testable without constructing a host.

import type {
  AgentSessionTurnActivity,
  AgentSessionWireRefusal
} from '../../../shared/agent-session-wire'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession,
  StructuredAgentSessionProviderChildIdentity
} from './structured-agent-session-host-types'
import type { StructuredAgentSessionHostRuntimeState } from './structured-agent-session-host-runtime-state'
import type { StructuredAgentSessionLifetimeContext } from './structured-agent-session-host-lifetime'
import type { StructuredAgentSessionTaskQueue } from './structured-agent-session-task-queue'
import type { StructuredAgentSessionConversationOpenOptions } from './structured-agent-session-conversation-open'

export type StructuredAgentSessionAttachContext = {
  deps: StructuredAgentSessionHostDeps
  runtimeState: StructuredAgentSessionHostRuntimeState
  sessions: Map<string, StructuredAgentSessionHostSession>
  subscribers: {
    snapshot: (sessionId: string, journal: AgentSessionJournal, fence: number) => void
    publish: (
      sessionId: string,
      journal: AgentSessionJournal,
      activity?: AgentSessionTurnActivity | null
    ) => void
  }
  tasks: StructuredAgentSessionTaskQueue
  reconcileLeases: (sessionId: string) => Promise<AgentSessionWireRefusal | null>
  serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
  now: () => number
  publishStatus: (sessionId: string) => void
  openProviderChild?: (
    sessionId: string,
    child: StructuredAgentSessionProviderChildIdentity
  ) => void
  generationEnded?: StructuredAgentSessionLifetimeContext['generationEnded']
  /** Route joined Stop exits through the single child-exit handler. */
  endExitedChild: StructuredAgentSessionLifetimeContext['endExitedChild']
  wakeDelivery?: StructuredAgentSessionLifetimeContext['wakeDelivery']
  /** Reopen the conversation-owned journal when needed. */
  openConversation: (
    sessionId: string,
    options?: StructuredAgentSessionConversationOpenOptions
  ) => Promise<StructuredAgentSessionHostSession | null>
}

export type StructuredAgentSessionAttachOptions = {
  hostLaunchDirectory?: string
  /** The saved list a new chat's options are admitted against, for the folder its picker read. */
  catalogModels?: AttachFlowInput['models']
  recordPhase?: AgentSessionCreatePhaseRecorder
  onAcquisitionFailed?: AttachFlowInput['onAcquisitionFailed']
  /** The queued message a start is for; see `StructuredAgentSessionProviderChild.startedFor`. */
  startedFor?: string
  startupOptions?: Readonly<Record<string, string>>
  /** A close, an admitted Stop or quit aborted this attach: its refusal is that abort's. */
  onAborted?: () => void
  /** The startup limit aborted this attach's acquire: it failed, nobody stopped it. */
  onStartupExpired?: () => void
  /** An agent start's: its steps run outside the session's serialize and commit under it. */
  lock?: StructuredAgentSessionAttachLock
  startupAttemptId?: string
  /** The attach made its child the session's. */
  onPublished?: () => void
}
