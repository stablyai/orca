import type {
  AgentSessionResumeSelection,
  AgentSessionResumeDisposition
} from '../../../runtime/agent-session/records/agent-session-recovery-capsule'
import type { AgentSessionRecordStore } from '../../../runtime/agent-session/records/agent-session-record-store'
import type { AgentSessionResumeMarker } from '../../../../shared/agent-session/lifecycle/agent-session-resume-marker'
import type { AgentSessionJournal } from '../../agent-session-journal/journal-store'
import type { CommandReceiptDiscovery } from '../../agent-session-journal/writing/command-receipt-table'
import {
  selectRestartAttempt,
  type RestartAttempt
} from './structured-agent-session-restart-attempt'
import { restartOfferTag } from './structured-agent-session-restart-continuation-envelope'

/** Re-read receipts inside exact batch settlement so an older action cannot overwrite a retry. */
export function createRestartSettlementReconciler(input: {
  store: Pick<AgentSessionRecordStore, 'discoverTaggedSendReceipts' | 'readCommandReceipt'>
  selections: readonly AgentSessionResumeSelection[]
  attempts: ReadonlyMap<string, RestartAttempt>
  sessions: ReadonlyMap<string, { journal: AgentSessionJournal }>
  personalStop: (marker: AgentSessionResumeMarker) => boolean | 'unknown'
  movedOn: (
    marker: AgentSessionResumeMarker,
    personalStop: boolean | 'unknown',
    attemptId: string
  ) => boolean | 'unknown'
}): (
  selection: AgentSessionResumeSelection,
  disposition: AgentSessionResumeDisposition
) => AgentSessionResumeDisposition | null {
  let currentReceipts: Map<string, CommandReceiptDiscovery> | undefined
  return (selection, disposition) => {
    const { marker } = selection
    const personalStop = input.personalStop(marker)
    if (personalStop === true) {
      return { kind: 'cancelled' }
    }
    const attempt = input.attempts.get(marker.sessionId)
    if (attempt?.kind !== 'send') {
      return disposition
    }
    const journal = input.sessions.get(marker.sessionId)?.journal
    if (!journal) {
      return null
    }
    currentReceipts ??= input.store.discoverTaggedSendReceipts(
      input.selections.map(({ marker }) => ({
        sessionId: marker.sessionId,
        tag: restartOfferTag(marker)
      }))
    )
    const current = selectRestartAttempt(selection, journal, currentReceipts.get(marker.sessionId))
    if (current.kind === 'unknown') {
      return null
    }
    if (
      current.kind === 'send' &&
      (current.predecessor ?? current.id) !== attempt.id &&
      (journal.submission(current.predecessor ?? current.id) ||
        journal.queuedMessages.get(current.predecessor ?? current.id) ||
        currentReceipts.get(marker.sessionId)?.verdict === 'unreadable' ||
        input.store.readCommandReceipt({ kind: 'global' }, current.predecessor ?? current.id)
          .verdict !== 'absent')
    ) {
      return null
    }
    const movedOn = input.movedOn(marker, personalStop, attempt.id)
    if (movedOn === 'unknown') {
      return null
    }
    if (movedOn) {
      return { kind: 'complete' }
    }
    const read = input.store.readCommandReceipt({ kind: 'global' }, attempt.id)
    const submission = journal.submission(attempt.id)
    if (read.verdict === 'readable' || submission || journal.queuedMessages.get(attempt.id)) {
      return disposition
    }
    return disposition.kind === 'failed' ? null : disposition
  }
}
