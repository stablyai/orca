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
import { throwIfSignalAborted } from '../../../shared/abort-signal-reason'
import type { StructuredAgentSessionAttachContext } from './structured-agent-session-attach-context'

export async function prepareCreateTranscript(
  context: StructuredAgentSessionAttachContext,
  params: AgentSessionAttachParams
) {
  const acquisition = context.runtimeState.acquireAborts.begin(params.envelope.sessionId)
  try {
    return await prepareAdoptedTranscript(params, acquisition.signal)
  } finally {
    acquisition.end()
  }
}

export async function prepareAdoptedTranscript(
  params: AgentSessionAttachParams,
  signal?: AbortSignal
): Promise<
  | { ok: true; items: JournalReplacementItem[] | null }
  | { ok: false; refusal: AgentSessionWireRefusal }
> {
  if (!params.adopt) {
    return { ok: true, items: null }
  }
  try {
    throwIfSignalAborted(signal)
    const items = await readAdoptedTranscript(params, signal)
    throwIfSignalAborted(signal)
    return { ok: true, items }
  } catch (error) {
    return {
      ok: false,
      refusal: isAgentSessionRefusalError(error)
        ? error.refusal
        : refuse(
            'agent_session_identity_required',
            { reason: 'transcriptUnreadable' },
            error instanceof Error ? error.message : String(error)
          )
    }
  }
}

// Validate before a new record can claim the provider conversation.
async function readAdoptedTranscript(
  params: AgentSessionAttachParams,
  signal?: AbortSignal
): Promise<JournalReplacementItem[] | null> {
  const adopt = params.adopt
  if (!adopt) {
    return null
  }
  if (!adopt.transcriptPath) {
    throw agentSessionRefusalError('agent_session_identity_required', {
      reason: 'transcriptNotFound'
    })
  }
  const prepared = await prepareLegacyTranscriptImport({
    agent: params.agent,
    sessionId: adopt.providerHandle.nativeId,
    options: { filePath: adopt.transcriptPath, source: adopt.source, signal }
  })
  if (!prepared.ok) {
    throw new Error(prepared.error)
  }
  if (prepared.items.length === 0) {
    throw agentSessionRefusalError('agent_session_identity_required', {
      reason: prepared.sourceEmpty ? 'transcriptNotFound' : 'transcriptUnreadable'
    })
  }
  return prepared.items
}

// Import before publication so visible history agrees with resumed provider context.
export async function importAdoptedTranscript(
  params: AgentSessionAttachParams,
  attached: AttachedJournal,
  record: AgentSessionRecord,
  prepared: JournalReplacementItem[] | null,
  options: { uncommittedCreate?: true } = {}
): Promise<void> {
  if (options.uncommittedCreate) {
    // Rolled-back creates may leave unowned imported history.
    if (prepared || attached.journal.cursor().sequence > 1) {
      await attached.journal.replaceEpochItems(
        params.adopt ? 'legacy_import' : 'session_created',
        record.lease.runtimeFence,
        prepared ?? []
      )
    }
    return
  }
  // Failed import must not close the conversation-owned journal.
  await applyAdoptedTranscript(params, attached, record, prepared)
}

async function applyAdoptedTranscript(
  params: AgentSessionAttachParams,
  attached: AttachedJournal,
  record: AgentSessionRecord,
  prepared: JournalReplacementItem[] | null
): Promise<void> {
  const adopt = params.adopt
  // Preserve durable writes after the initial epoch row.
  if (!adopt || attached.journal.cursor().sequence > 1) {
    return
  }
  if (prepared) {
    await attached.journal.replaceEpochItems('legacy_import', record.lease.runtimeFence, prepared)
    return
  }
  if (!adopt.transcriptPath) {
    throw agentSessionRefusalError('agent_session_identity_required', {
      reason: 'transcriptNotFound'
    })
  }
  const imported = await importLegacyTranscriptIntoJournal({
    journal: attached.journal,
    agent: params.agent,
    sessionId: adopt.providerHandle.nativeId,
    fence: record.lease.runtimeFence,
    options: { filePath: adopt.transcriptPath, source: adopt.source }
  })
  if (!imported.ok) {
    throw new Error(imported.error)
  }
  // Empty decode contradicts the adopted provider conversation; refuse rather than show an empty chat.
  if (!imported.replaced) {
    throw agentSessionRefusalError('agent_session_identity_required', {
      reason: 'transcriptUnreadable'
    })
  }
}
