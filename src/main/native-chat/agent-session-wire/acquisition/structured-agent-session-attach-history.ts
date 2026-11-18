import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import { agentSessionRefusalError } from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import type { JournalReplacementItem } from '../../agent-session-journal/context-epochs/journal-epoch-replacement'
import { attachJournal, type AttachedJournal } from './structured-agent-session-attach'
import {
  importAdoptedTranscript,
  readPendingAdoptedTranscript
} from './structured-agent-session-adopted-import'
import type { AttachFlowInput, AttachedOwner } from './structured-agent-session-attach-flow'
import type { StructuredAgentSessionAttachLock } from './structured-agent-session-attach-lock'

export async function attachSessionJournalHistory(input: {
  flow: AttachFlowInput
  record: AgentSessionRecord
  lock: StructuredAgentSessionAttachLock
  prepared: JournalReplacementItem[] | null
  owner: AttachedOwner
  onAttached: (journal: AttachedJournal) => Promise<void> | void
}): Promise<AttachedJournal> {
  const { flow, record, lock } = input
  const attached = await lock.commit(async () => {
    await flow.beforeJournalOpen?.()
    return attachJournal({ record, openConversation: flow.openConversation })
  })
  const prepared = await lock.wait(
    readPendingAdoptedTranscript(flow.params, attached, input.prepared, lock.signal, flow.adapter)
  )
  await lock.commit(async () => {
    const current = flow.store.getRecord(record.sessionId)
    if (
      !current ||
      current.lease.runtimeFence !== record.lease.runtimeFence ||
      current.lease.claimStatus === 'conflicted' ||
      (input.owner !== 'none' && current.lease.claimStatus === 'released')
    ) {
      throw agentSessionRefusalError('agent_session_ownership_unknown', { reason: 'leaseMoved' })
    }
    await importAdoptedTranscript(flow.params, attached, current, prepared, { store: flow.store })
    await input.onAttached(attached)
  })
  return attached
}
