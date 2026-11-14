import type { JournalForkInstall } from './journal-fork-stages'
import type { JournalSendAdmission } from './journal-send-admission'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionExecutionOptions } from '../../../shared/agent-session/options/protocol/agent-session-execution-options'
import type { AgentSessionQueuedMessageMoveAnchor } from '../../../shared/agent-session/requests/agent-session-queued-message-wire'
import type { AgentSessionProviderContextBoundary } from '../../../shared/agent-session/agent-session-provider-context'
import type {
  AgentJournalEpochReason,
  JournalEpochRow,
  JournalStopEvent
} from './durable-rows/journal-row-schema'
import type { JournalReplacementItem } from './context-epochs/journal-epoch-replacement'
import type { QueuedMessageHoldReason } from './queued-messages/queued-message-table'
import type { AgentJournalDispatchRejection } from '../../../shared/agent-session/failures/agent-session-failure-words'
import type { JournalSubmissionSelector } from './journal-submission-selector'
import type { QueuedMessageUpdate } from './queued-messages/queued-message-update'
import type {
  JournalItemAppendOptions,
  JournalLateDispatchInput,
  JournalShutdownCutInput,
  JournalCommandSettlementInput,
  JournalCommandOpenInput,
  JournalHandoverInput,
  JournalSubmissionConsume,
  JournalSubmissionInput,
  JournalDeadGenerationSettlementInput,
  JournalStaleSettlementInput,
  JournalPromptMutationInput,
  JournalUnheldTurnsSettlementInput,
  JournalStartFailureSettlementInput,
  JournalItemAppendInput,
  JournalLifecycleBatchInput,
  ResolveDispatchInput
} from './journal-store-contracts'
import type {
  AgentJournalCursor,
  AgentJournalItemIdentity
} from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { JournalWriterEffect } from './journal-writer-effects'
import type { JournalWriterHostFacts } from './journal-writer-host-facts'
import type { JournalWriterStep } from './writing/journal-writer-step'
import type { JournalDomainEditLeaseOperation } from './journal-domain-edit-leases'
import type { AgentSessionRewindRecord } from '../../../shared/agent-session/lifecycle/rewind/agent-session-rewind'
import type { JournalRewindCut } from './journal-domain-rewind-cut'

/** The writer chooses the projection epoch; callers identify only their live open handle. */
export type JournalWriterTarget = { sessionId: string; epoch: string; ownerToken: string }

export type JournalWriterCoreOperation =
  | ({ kind: 'item' } & JournalItemAppendInput)
  | { kind: 'tombstone'; identity: AgentJournalItemIdentity; fence: number }
  | {
      kind: 'lifecycle'
      input: JournalLifecycleBatchInput
      takenStop?: { turnId: string; completedAt: number }
    }
  | { kind: 'dispatch'; input: ResolveDispatchInput; onlyIfUnsettled?: true }
  | { kind: 'stop'; event: Omit<JournalStopEvent, 'at'>; fence: number }
  | { kind: 'queue-resume'; fence: number; onlyRestarted?: true }
  | { kind: 'queue-reopen'; fence: number; since?: number }

export type JournalWriterOperation =
  | JournalWriterCoreOperation
  | JournalWriterInputOperation
  | {
      kind: 'steps'
      steps: readonly JournalWriterStep[]
      dropped?: boolean
    }

/** No callbacks, pre-folded outcomes, assigned revisions or host-chosen durability cross this port. */
export type JournalWriterCommand = {
  forkInstall?: JournalForkInstall
  target: JournalWriterTarget
  operation: JournalWriterOperation
  effects?: readonly JournalWriterEffect[]
  /** Host-memory facts; commands that read none may omit them. */
  facts?: JournalWriterHostFacts
  /** The host's clock at admission, so host-staged receipts agree with the row's time. */
  savedAt?: number
}

export type JournalWriterInputOperation =
  | ({ kind: 'send-admission' } & JournalSendAdmission)
  | { kind: 'automatic-submission'; clientMessageId: string; fence: number }
  | { kind: 'edit-lease'; operation: JournalDomainEditLeaseOperation }
  | {
      kind: 'submission'
      input: JournalSubmissionInput
      /** `owed` asks the host, after validation, whether mail is still owed at handover. */
      consume?: Omit<JournalSubmissionConsume, 'owed'> & { owed?: true }
    }
  | { kind: 'accept-late'; input: Extract<ResolveDispatchInput, { state: 'accepted' }> }
  | { kind: 'late-dispatch'; input: JournalLateDispatchInput }
  | { kind: 'shutdown-cut'; input: JournalShutdownCutInput }
  | { kind: 'command-settle'; input: JournalCommandSettlementInput }
  | { kind: 'command-open'; input: JournalCommandOpenInput }
  | { kind: 'handover'; input: JournalHandoverInput }
  | {
      kind: 'queue-insert'
      input: {
        messageId: string
        body: AgentJournalMessageItem
        requireAttachments?: true
        holdReason?: QueuedMessageHoldReason
        options?: AgentSessionExecutionOptions
        deliveryMode?: 'queue' | 'steer'
        unattended?: boolean
      }
    }
  | { kind: 'queue-update'; input: QueuedMessageUpdate }
  | { kind: 'queue-hold'; messageIds: readonly string[]; reason: QueuedMessageHoldReason }
  | { kind: 'queue-withdraw'; messageIds: readonly string[] }
  | { kind: 'queue-move'; input: { messageId: string } & AgentSessionQueuedMessageMoveAnchor }
  | { kind: 'queue-reopen-mark'; fence: number; since?: number }
  | { kind: 'pending-unknown'; fence: number; reason?: string }
  | { kind: 'pending-reject'; fence: number; rejection: AgentJournalDispatchRejection }
  | {
      kind: 'queued-reject'
      fence: number
      rejection: AgentJournalDispatchRejection
      select?: JournalSubmissionSelector
    }
  | {
      kind: 'hold-unsent'
      fence: number
      hold: { cause: 'hostRestarted' } | { cause: 'chatClosed'; select?: JournalSubmissionSelector }
      unrun?: true | JournalSubmissionSelector
    }
  | {
      kind: 'stop-accept'
      event: Omit<JournalStopEvent, 'at'>
      fence: number
      /** The host's current-work answer, read on its lane just before this command. */
      liveTurnId: string | null
    }
  | { kind: 'goal-withdraw'; identity: AgentJournalItemIdentity; fence: number }
  | {
      kind: 'item-claiming'
      identity: AgentJournalItemIdentity
      body: AgentJournalMessageItem
      options: JournalItemAppendOptions
    }
  | { kind: 'open'; recover?: { fence: number } }
  | JournalWriterContextOperation
  | JournalWriterSettlementOperation

export type JournalWriterContextOperation =
  | { kind: 'fork-install' }
  | {
      kind: 'rewind-cut'
      rewind: AgentSessionRewindRecord
      fence: number
      expectedCut: JournalRewindCut | null
    }
  | { kind: 'context-clear'; boundary: AgentSessionProviderContextBoundary }
  | {
      kind: 'context-rewind'
      floor: AgentJournalCursor
      fence: number
      items: readonly JournalReplacementItem[]
    }
  | {
      kind: 'epoch-replace'
      historyOrigin?: JournalEpochRow['historyOrigin']
      reason: AgentJournalEpochReason
      fence: number
      items: readonly JournalReplacementItem[]
      providerHandle?: JournalEpochRow['providerHandle']
    }

export type JournalWriterSettlementOperation =
  | { kind: 'stale-settle'; input: JournalStaleSettlementInput }
  | { kind: 'dead-generation-settle'; input: JournalDeadGenerationSettlementInput }
  | { kind: 'unheld-turns-settle'; input: JournalUnheldTurnsSettlementInput }
  | { kind: 'start-failure-settle'; input: JournalStartFailureSettlementInput }
  | { kind: 'prompt-mutate'; input: JournalPromptMutationInput }
