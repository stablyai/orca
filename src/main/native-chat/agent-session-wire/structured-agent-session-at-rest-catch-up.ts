import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { asRecord, parseJsonObject } from '../../ai-vault/session-scanner-values'
import {
  readCodexHistoryJournalView,
  sameCodexHistoryJournalView
} from '../../codex/codex-history-journal-view'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { agentSessionRefusalError } from '../../../shared/agent-session-wire-refusals'
import type { AgentSessionSwitchDeadline } from '../../../shared/agent-session-switch-execution'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { createLegacyIdentityTracker } from '../agent-session-journal/journal-legacy-identity'
import {
  legacyItemBody,
  LEGACY_IMPORT_BLOCK_LIMITS
} from '../agent-session-journal/journal-legacy-import'
import type { JournalReplacementItem } from '../agent-session-journal/journal-epoch-replacement'
import { splitTranscriptStreamLines } from '../transcript-stream-lines'
import {
  decodeCodexTranscriptLine,
  isCodexVisibleHistoryRecord
} from '../transcript-line-decoders-codex'
import { decodeCodexTurnLifecycle } from '../transcript-turn-lifecycle'

/** Refresh a retained read owner without starting a provider or replacing native submissions. */
export async function catchUpStructuredSessionAtRest(input: {
  journal: AgentSessionJournal
  threadId: string
  filePath: string
  fence: number
  deadline: AgentSessionSwitchDeadline
  stoppedTurnId?: string
  check?: () => void
}): Promise<void> {
  const { journal, threadId, deadline } = input
  const view = readCodexHistoryJournalView(journal, threadId)
  const tracker = createLegacyIdentityTracker({
    transcriptAgent: 'codex',
    agent: 'codex',
    sessionId: threadId
  })
  if (view.unresolvedOrigin) {
    throw agentSessionRefusalError('agent_session_identity_required', {
      reason: 'transcriptUnreadable'
    })
  }
  const items: JournalReplacementItem[] = []
  let bytes = 0
  const retain = (item: JournalReplacementItem) => {
    bytes += Buffer.byteLength(JSON.stringify(item))
    if (bytes > 16 * 1024 * 1024) {
      throw agentSessionRefusalError('agent_session_identity_required', {
        reason: 'transcriptUnreadable'
      })
    }
    items.push(item)
  }
  let turn: string | undefined
  let include = false
  let identityConfirmed = false
  let paginated = false
  let index = 0
  const stream = createReadStream(input.filePath, { signal: deadline.signal })
  for await (const { line } of splitTranscriptStreamLines(stream, 16 * 1024 * 1024)) {
    deadline.check()
    const currentLineIndex = index++
    const record = parseJsonObject(line)
    const payload = asRecord(record?.payload)
    if (record?.type === 'session_meta') {
      if (payload?.id !== threadId) {
        throw agentSessionRefusalError('agent_session_identity_required', {
          reason: 'transcriptUnreadable'
        })
      }
      identityConfirmed = true
      paginated = payload?.history_mode === 'paginated'
    }
    const lifecycle = decodeCodexTurnLifecycle(line, '')
    if (lifecycle?.state === 'working') {
      if (include) {
        throw agentSessionRefusalError('agent_session_operation_invalid', {
          reason: 'messagesUnsettled'
        })
      }
      turn = lifecycle.turnId || undefined
      include = Boolean(
        turn &&
        !view.known.has(turn) &&
        lifecycle.timestamp !== null &&
        (view.importedAt === null || lifecycle.timestamp > view.importedAt)
      )
    }
    if (!include || !turn) {
      continue
    }
    if (lifecycle && lifecycle.state !== 'working') {
      if (lifecycle.turnId !== turn) {
        throw agentSessionRefusalError('agent_session_operation_invalid', {
          reason: 'messagesUnsettled'
        })
      }
      retain({
        identity: {
          provider: 'legacy',
          agent: 'codex',
          sessionId: threadId,
          recordId: `turn-lifecycle:${turn}`
        },
        body: {
          kind: 'turn',
          turnId: turn,
          state: lifecycle.state,
          ...(lifecycle.outcome
            ? { outcome: lifecycle.outcome }
            : lifecycle.state === 'interrupted' && turn === input.stoppedTurnId
              ? { outcome: 'cancellation' as const }
              : {}),
          ...(lifecycle.timestamp === null ? {} : { completedAt: lifecycle.timestamp })
        },
        ownerFence: 0,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      })
      include = false
      continue
    }
    if (!isCodexVisibleHistoryRecord(record, paginated)) {
      continue
    }
    const message = decodeCodexTranscriptLine(line, `#${currentLineIndex}`, { historyImport: true })
    if (message) {
      retain({
        identity: tracker.identify(line, currentLineIndex),
        body: legacyItemBody(message, LEGACY_IMPORT_BLOCK_LIMITS),
        ownerFence: 0,
        turnScope: {
          kind: 'turn',
          turnItemId: agentJournalItemKey({
            provider: 'legacy',
            agent: 'codex',
            sessionId: threadId,
            recordId: `turn-lifecycle:${turn}`
          })
        },
        ...(message.timestamp === null ? {} : { observedAt: message.timestamp })
      })
    }
  }
  deadline.check()
  if (!identityConfirmed) {
    throw agentSessionRefusalError('agent_session_identity_required', {
      reason: 'transcriptUnreadable'
    })
  }
  // Incomplete source turns must remain retryable rather than being declared covered.
  if (include && turn !== input.stoppedTurnId) {
    throw agentSessionRefusalError('agent_session_operation_invalid', {
      reason: 'messagesUnsettled'
    })
  }
  if (!items.length) {
    return
  }
  const digest = createHash('sha256').update(JSON.stringify(items)).digest('hex')
  await journal.appendPlannedLifecycleBatch({
    settlementId: `at-rest:${digest}`,
    fence: input.fence,
    plan: () => {
      deadline.check()
      input.check?.()
      if (!sameCodexHistoryJournalView(view, readCodexHistoryJournalView(journal, threadId))) {
        throw agentSessionRefusalError('agent_session_operation_invalid', {
          reason: 'messagesUnsettled'
        })
      }
      return {
        dispatches: [],
        mutations: items
          .filter((item) => !journal.item(agentJournalItemKey(item.identity)))
          .map((item) => ({
            kind: 'item' as const,
            ...item,
            turnScope: item.turnScope ?? AGENT_JOURNAL_THREAD_SCOPE
          }))
      }
    }
  })
}
