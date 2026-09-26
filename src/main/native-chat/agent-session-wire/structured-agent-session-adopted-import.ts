import {
  agentSessionRefusalError,
  isAgentSessionRefusalError,
  refuse,
  type AgentSessionWireRefusal
} from '../../../shared/agent-session-wire'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionAttachParams, AttachedJournal } from './structured-agent-session-attach'
import type { JournalReplacementItem } from '../agent-session-journal/journal-epoch-replacement'
import {
  importLegacyTranscriptIntoJournal,
  prepareLegacyTranscriptImport
} from '../agent-session-journal/journal-legacy-import'

export async function prepareAdoptedTranscript(
  params: AgentSessionAttachParams
): Promise<
  | { ok: true; items: JournalReplacementItem[] | null }
  | { ok: false; refusal: AgentSessionWireRefusal }
> {
  try {
    return { ok: true, items: await readAdoptedTranscript(params) }
  } catch (error) {
    return {
      ok: false,
      refusal: isAgentSessionRefusalError(error)
        ? error.refusal
        : refuse(
            'agent_session_identity_required',
            'transcriptUnreadable',
            error instanceof Error ? error.message : String(error)
          )
    }
  }
}

// Validate source input before a new record can claim the provider conversation.
async function readAdoptedTranscript(
  params: AgentSessionAttachParams
): Promise<JournalReplacementItem[] | null> {
  const adopt = params.adopt
  if (!adopt) {
    return null
  }
  if (!adopt.transcriptPath) {
    throw agentSessionRefusalError('agent_session_identity_required', 'transcriptNotFound')
  }
  const prepared = await prepareLegacyTranscriptImport({
    agent: params.agent,
    sessionId:
      adopt.providerHandle.kind === 'claude'
        ? adopt.providerHandle.sessionId
        : adopt.providerHandle.threadId,
    options: { filePath: adopt.transcriptPath }
  })
  if (!prepared.ok) {
    throw new Error(prepared.error)
  }
  if (prepared.items.length === 0) {
    throw agentSessionRefusalError('agent_session_identity_required', 'transcriptUnreadable')
  }
  return prepared.items
}

// Import before publication so the first visible chat agrees with the provider's resumed context.
export async function importAdoptedTranscript(
  params: AgentSessionAttachParams,
  attached: AttachedJournal,
  record: AgentSessionRecord,
  prepared: JournalReplacementItem[] | null
): Promise<void> {
  // The journal is the conversation's, which outlives a failed import; nothing here closes it.
  await applyAdoptedTranscript(params, attached, record, prepared)
}

async function applyAdoptedTranscript(
  params: AgentSessionAttachParams,
  attached: AttachedJournal,
  record: AgentSessionRecord,
  prepared: JournalReplacementItem[] | null
): Promise<void> {
  const adopt = params.adopt
  // A new journal contains only its epoch row; replay must preserve subsequent durable writes.
  if (!adopt || attached.journal.cursor().sequence > 1) {
    return
  }
  if (prepared) {
    await attached.journal.replaceEpochItems('legacy_import', record.lease.runtimeFence, prepared)
    return
  }
  if (!adopt.transcriptPath) {
    throw agentSessionRefusalError('agent_session_identity_required', 'transcriptNotFound')
  }
  const imported = await importLegacyTranscriptIntoJournal({
    journal: attached.journal,
    agent: params.agent,
    sessionId:
      adopt.providerHandle.kind === 'claude'
        ? adopt.providerHandle.sessionId
        : adopt.providerHandle.threadId,
    fence: record.lease.runtimeFence,
    options: { filePath: adopt.transcriptPath }
  })
  if (!imported.ok) {
    throw new Error(imported.error)
  }
  // `replaced: false` means the transcript decoded to nothing. The row promised a conversation and
  // the provider resumed one, so an empty journal here is a disagreement, not an empty chat.
  if (!imported.replaced) {
    throw agentSessionRefusalError('agent_session_identity_required', 'transcriptUnreadable')
  }
}
