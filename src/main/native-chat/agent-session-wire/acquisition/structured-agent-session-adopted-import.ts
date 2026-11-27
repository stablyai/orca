import { ClaudeImportResourceError } from '../../agent-session-journal/history-import/journal-claude-import-resource-error'
import {
  journalClaudeImport,
  type ClaudeImportStage,
  type PrepareClaudeImport
} from '../../agent-session-journal/history-import/journal-claude-import-stage'
import type { JournalOperationReceipt } from '../../agent-session-journal/writing/journal-row-writer'
import { resolveNativeChatTranscriptAgent } from '../../../../shared/native-chat/native-chat-agent-support'
import type { JournalForkInstall } from '../../agent-session-journal/journal-fork-stages'
import type { AgentSessionRecordStore } from '../../../runtime/agent-session/records/agent-session-record-store'
import {
  agentSessionRefusalError,
  isAgentSessionRefusalError,
  refuse,
  type AgentSessionWireRefusal
} from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type { AgentSessionAttachParams, AttachedJournal } from './structured-agent-session-attach'
import type { JournalReplacementItem } from '../../agent-session-journal/context-epochs/journal-epoch-replacement'
import {
  prepareClaudeLegacyImport,
  prepareLegacyTranscriptImport
} from '../../agent-session-journal/history-import/journal-legacy-import'
import { throwIfSignalAborted } from '../../../../shared/concurrency/abort-signal-reason'
import type { StructuredAgentSessionAttachContext } from './structured-agent-session-attach-context'

export type PreparedAdoptedTranscript = JournalReplacementItem[] | ClaudeImportStage | null

export function adoptedFoundingReceipt(
  prepared: PreparedAdoptedTranscript,
  hasFirstMessage: boolean,
  receipt: () => JournalOperationReceipt
) {
  return prepared && !Array.isArray(prepared) && !hasFirstMessage ? receipt() : undefined
}

export function closePreparedAdoptedTranscript(prepared: PreparedAdoptedTranscript) {
  return prepared && !Array.isArray(prepared) ? prepared.close() : undefined
}

export async function prepareCreateTranscript(
  context: StructuredAgentSessionAttachContext,
  params: AgentSessionAttachParams
) {
  const acquisition = context.runtimeState.acquireAborts.begin(params.envelope.sessionId)
  let staged = false
  try {
    const prepared = await prepareAdoptedTranscript(
      params,
      acquisition.signal,
      journalClaudeImport(context.deps.journalDatabase)
    )
    if (prepared.ok && prepared.items && !Array.isArray(prepared.items)) {
      const history = prepared.items
      staged = true
      return {
        ...prepared,
        items: {
          ...history,
          async close() {
            try {
              await history.close()
            } finally {
              acquisition.end()
            }
          }
        }
      }
    }
    return prepared
  } finally {
    if (!staged) {
      acquisition.end()
    }
  }
}

export async function prepareAdoptedTranscript(
  params: AgentSessionAttachParams,
  signal?: AbortSignal,
  prepareClaude?: PrepareClaudeImport
): Promise<
  { ok: true; items: PreparedAdoptedTranscript } | { ok: false; refusal: AgentSessionWireRefusal }
> {
  if (params.fork) {
    return { ok: true, items: null }
  }
  if (!params.adopt) {
    return { ok: true, items: null }
  }
  try {
    throwIfSignalAborted(signal)
    const items = await readAdoptedTranscript(params, signal, prepareClaude)
    if (signal?.aborted) {
      await closePreparedAdoptedTranscript(items)
      throwIfSignalAborted(signal)
    }
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
  signal?: AbortSignal,
  prepareClaude?: PrepareClaudeImport
): Promise<PreparedAdoptedTranscript> {
  const adopt = params.adopt
  if (!adopt) {
    return null
  }
  if (!adopt.transcriptPath) {
    throw agentSessionRefusalError('agent_session_identity_required', {
      reason: 'transcriptNotFound'
    })
  }
  const input = {
    agent: params.agent,
    sessionId: adopt.providerHandle.nativeId,
    options: { filePath: adopt.transcriptPath, source: adopt.source, signal }
  }
  if (resolveNativeChatTranscriptAgent(params.agent) === 'claude') {
    if (!prepareClaude) {
      throw new Error('Claude history import requires a journal writer.')
    }
    const staged = await prepareClaudeLegacyImport(input, prepareClaude, {
      sessionId: params.envelope.sessionId,
      operationId: params.envelope.clientOperationId,
      fingerprint: params.envelope.payloadFingerprint
    })
    if (staged.count) {
      return staged
    }
    await staged.close()
    throw agentSessionRefusalError('agent_session_identity_required', {
      reason: staged.sourceEmpty ? 'transcriptNotFound' : 'transcriptUnreadable'
    })
  }
  const prepared = await prepareLegacyTranscriptImport(input)
  if (!prepared.ok) {
    throw isAgentSessionRefusalError(prepared.cause) ? prepared.cause : new Error(prepared.error)
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
  prepared: PreparedAdoptedTranscript,
  options: {
    uncommittedCreate?: true
    store?: AgentSessionRecordStore
    receipt?: JournalOperationReceipt
    prepareClaudeImport?: PrepareClaudeImport
  } = {}
): Promise<JournalForkInstall | undefined> {
  if (params.fork) {
    const installation = await attached.journal.stageFork(params.fork.prepared, {
      fence: record.lease.runtimeFence,
      operationId: params.envelope.clientOperationId,
      fingerprint: params.envelope.payloadFingerprint,
      historyOrigin: params.fork.historyOrigin
    })
    if (options.uncommittedCreate) {
      return installation
    }
    if (!options.store) {
      throw new Error('fork adoption requires its record receipt owner')
    }
    let installed = false
    try {
      const receipt = options.store.conversationReceipts.forkBoundary(record.sessionId, {
        sessionId: params.fork.sessionId,
        itemId: params.fork.itemId,
        childBoundary: { kind: 'start' }
      })
      await params.fork.withAdmission(() =>
        attached.journal.write({ kind: 'fork-install' }, () => ({
          receipt,
          forkInstall: installation
        }))
      )
      installed = true
    } finally {
      if (!installed) {
        await attached.journal.abortFork(installation)
      }
    }
    return
  }
  if (prepared && !Array.isArray(prepared)) {
    if (options.uncommittedCreate || attached.journal.cursor().sequence <= 1) {
      await installAdoptedClaudeHistory(prepared, attached, record, options.receipt)
    }
    return
  }
  if (options.uncommittedCreate) {
    // Rolled-back creates may leave unowned imported history.
    if (prepared || attached.journal.cursor().sequence > 1) {
      await attached.journal.write({
        kind: 'epoch-replace',
        reason: params.adopt ? 'legacy_import' : 'session_created',
        fence: record.lease.runtimeFence,
        items: prepared ?? []
      })
    }
    return
  }
  // Failed import must not close the conversation-owned journal.
  await applyAdoptedTranscript(params, attached, record, prepared, options.prepareClaudeImport)
  return undefined
}

async function applyAdoptedTranscript(
  params: AgentSessionAttachParams,
  attached: AttachedJournal,
  record: AgentSessionRecord,
  prepared: JournalReplacementItem[] | null,
  prepareClaudeImport?: PrepareClaudeImport
): Promise<void> {
  const adopt = params.adopt
  // Preserve durable writes after the initial epoch row.
  if (!adopt || attached.journal.cursor().sequence > 1) {
    return
  }
  if (prepared) {
    await attached.journal.write(
      {
        kind: 'epoch-replace',
        reason: 'legacy_import',
        fence: record.lease.runtimeFence,
        items: prepared
      },
      undefined
    )
    return
  }
  if (!adopt.transcriptPath) {
    throw agentSessionRefusalError('agent_session_identity_required', {
      reason: 'transcriptNotFound'
    })
  }
  const read = await readAdoptedTranscript(params, undefined, prepareClaudeImport)
  try {
    if (read && !Array.isArray(read)) {
      await installAdoptedClaudeHistory(read, attached, record)
    } else if (read?.length) {
      await applyAdoptedTranscript(params, attached, record, read)
    } else {
      throw agentSessionRefusalError('agent_session_identity_required', {
        reason: 'transcriptUnreadable'
      })
    }
  } finally {
    await closePreparedAdoptedTranscript(read)
  }
}

async function installAdoptedClaudeHistory(
  prepared: ClaudeImportStage,
  attached: AttachedJournal,
  record: AgentSessionRecord,
  receipt?: JournalOperationReceipt
): Promise<void> {
  try {
    await prepared.install(attached.journal, record.lease.runtimeFence, receipt)
  } catch (error) {
    if (error instanceof ClaudeImportResourceError) {
      throw agentSessionRefusalError(
        'agent_session_identity_required',
        { reason: 'transcriptUnreadable' },
        error.message
      )
    }
    throw error
  }
}
