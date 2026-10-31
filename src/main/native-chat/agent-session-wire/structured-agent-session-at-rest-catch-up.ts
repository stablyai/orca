import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { asRecord, parseJsonObject } from '../../ai-vault/session-scanner-values'
import {
  readCodexHistoryJournalView,
  sameCodexHistoryJournalView
} from '../../codex/codex-history-journal-view'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody
} from '../../../shared/agent-session-journal-types'
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
import {
  codexChildTurn,
  lifecycleIdentity,
  providerItemId,
  savedCodexPrompts
} from './structured-agent-session-codex-turns'
import {
  isSyntheticInterruptedTurn,
  isUnexplainedInterruptedTurn,
  turnRecordReplaceable,
  withNamedPrompt
} from './structured-agent-session-synthetic-turn'

type CodexTurn = {
  id: string
  /** Started after the last import: its rows are imported here. */
  messages: boolean
  /** Its rows are saved: only its record is derived here (its outcome, or the prompt it lacks). */
  baseline: boolean
  /** The turn's prompt row, so its record anchors to its own prompt wherever it sits. */
  opener?: string
  /** The turn's existing record that a later boundary may still replace, explain or anchor. */
  recorded?: Extract<AgentJournalItemBody, { kind: 'turn' }>
  ended: boolean
}

/**
 * Refresh a retained read owner without starting a provider or replacing native submissions. The
 * one writer of this thread's Codex turn records: turns started since the last import, and the
 * latest turn the import itself brought in. With no writer left (`settleAbandoned`), a turn the
 * provider never ended is over and settles as interrupted, as Codex's own thread reader reports it.
 */
export async function catchUpStructuredSessionAtRest(input: {
  journal: AgentSessionJournal
  threadId: string
  filePath: string
  fence: number
  deadline: AgentSessionSwitchDeadline
  stoppedTurnId?: string
  /** The saved prompt of the turn this switch stopped, for a transcript that never started it. */
  stoppedUserItemKey?: string
  /** The CLI writer census passed and the structured owner is at rest. */
  settleAbandoned?: boolean
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
  const saved = (turnId: string) =>
    journal.item(journal.canonicalItemId(agentJournalItemKey(lifecycleIdentity(threadId, turnId))))
      ?.body
  let prompts: Map<string, string> | undefined
  let turn: CodexTurn | undefined
  let baseline: JournalReplacementItem | undefined
  const children = new Set<string>()
  const started = new Set<string>()
  const record = (target: CodexTurn, body: Extract<AgentJournalItemBody, { kind: 'turn' }>) => {
    const item = {
      identity: lifecycleIdentity(threadId, target.id),
      ownerFence: 0,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    }
    // A record names its own prompt; one already saved keeps the prompt it names.
    const anchor = target.recorded?.userItemId ?? target.opener
    const anchored = anchor ? { ...body, userItemId: anchor } : body
    if (target.messages || target.recorded) {
      retain({ ...item, body: anchored })
    } else if (target.baseline) {
      // No saved prompt row to anchor to: write nothing rather than a dangling opener.
      baseline = target.opener ? { ...item, body: anchored } : undefined
    }
  }
  const close = (target: CodexTurn) => {
    target.ended = true
    if (input.settleAbandoned || target.id === input.stoppedTurnId) {
      record(target, {
        kind: 'turn',
        turnId: target.id,
        state: 'interrupted',
        ...(target.id === input.stoppedTurnId ? { outcome: 'cancellation' as const } : {})
      })
    } else if (target.messages) {
      // A writer may still be adding to it: stay retryable rather than declare it covered.
      throw agentSessionRefusalError('agent_session_operation_invalid', {
        reason: 'messagesUnsettled'
      })
    }
  }
  let identityConfirmed = false
  let paginated = false
  let index = 0
  const stream = createReadStream(input.filePath, { signal: deadline.signal })
  for await (const { line } of splitTranscriptStreamLines(stream, 16 * 1024 * 1024)) {
    deadline.check()
    const currentLineIndex = index++
    const parsed = parseJsonObject(line)
    const payload = asRecord(parsed?.payload)
    if (parsed?.type === 'session_meta') {
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
      if (codexChildTurn(payload)) {
        children.add(lifecycle.turnId)
        continue
      }
      if (turn && !turn.ended) {
        close(turn)
      }
      const id = lifecycle.turnId
      started.add(id)
      const imported =
        lifecycle.timestamp === null ||
        (view.importedAt !== null && lifecycle.timestamp <= view.importedAt)
      if (imported) {
        baseline = undefined
      }
      // A known turn is settled unless Orca settled it or its interruption still lacks a verdict;
      // a settled record an earlier import saved without its prompt only takes the prompt.
      const current = saved(id)
      const revisited = isSyntheticInterruptedTurn(current) || isUnexplainedInterruptedTurn(current)
      const unanchored = !revisited && current?.kind === 'turn' && !current.userItemId
      const open = revisited || !view.known.has(id)
      turn = id
        ? {
            id,
            messages: !imported && open,
            baseline: (imported && open) || unanchored,
            ...(current?.kind === 'turn' && (revisited || unanchored) ? { recorded: current } : {}),
            ended: false
          }
        : undefined
      continue
    }
    if (!turn || turn.ended || (!turn.messages && !turn.baseline)) {
      continue
    }
    if (lifecycle) {
      if (children.has(lifecycle.turnId)) {
        continue
      }
      if (lifecycle.turnId !== turn.id) {
        if (turn.messages) {
          throw agentSessionRefusalError('agent_session_operation_invalid', {
            reason: 'messagesUnsettled'
          })
        }
        continue
      }
      turn.ended = true
      record(turn, {
        kind: 'turn',
        turnId: turn.id,
        state: lifecycle.state,
        ...(lifecycle.outcome
          ? { outcome: lifecycle.outcome }
          : lifecycle.state === 'interrupted' && turn.id === input.stoppedTurnId
            ? { outcome: 'cancellation' as const }
            : {}),
        ...(lifecycle.timestamp === null ? {} : { completedAt: lifecycle.timestamp })
      })
      continue
    }
    if (!isCodexVisibleHistoryRecord(parsed, paginated)) {
      continue
    }
    const message = decodeCodexTranscriptLine(line, `#${currentLineIndex}`, { historyImport: true })
    if (!message) {
      continue
    }
    const identity = tracker.identify(line, currentLineIndex)
    if (message.role === 'user') {
      // The turn's last prompt, as the stop's own read names it: saved under either import's
      // scheme, or the row this import writes.
      prompts ??= savedCodexPrompts(journal, threadId)
      turn.opener =
        prompts.get(providerItemId(parsed) ?? '') ??
        (turn.messages ? agentJournalItemKey(identity) : turn.opener)
    }
    if (turn.baseline) {
      continue
    }
    retain({
      identity,
      body: legacyItemBody(message, LEGACY_IMPORT_BLOCK_LIMITS),
      ownerFence: 0,
      turnScope: {
        kind: 'turn',
        turnItemId: agentJournalItemKey(lifecycleIdentity(threadId, turn.id))
      },
      ...(message.timestamp === null ? {} : { observedAt: message.timestamp })
    })
  }
  deadline.check()
  if (!identityConfirmed) {
    throw agentSessionRefusalError('agent_session_identity_required', {
      reason: 'transcriptUnreadable'
    })
  }
  if (turn && !turn.ended) {
    close(turn)
  }
  if (baseline) {
    retain(baseline)
  }
  // A rollout with no turn events still names the prompt the switch stopped: the stop lands there.
  const stoppedPrompt =
    input.stoppedUserItemKey && journal.canonicalItemId(input.stoppedUserItemKey)
  if (
    input.stoppedTurnId &&
    !started.has(input.stoppedTurnId) &&
    !view.known.has(input.stoppedTurnId) &&
    stoppedPrompt &&
    journal.item(stoppedPrompt)
  ) {
    retain({
      identity: lifecycleIdentity(threadId, input.stoppedTurnId),
      ownerFence: 0,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE,
      body: {
        kind: 'turn',
        turnId: input.stoppedTurnId,
        userItemId: stoppedPrompt,
        state: 'interrupted',
        outcome: 'cancellation'
      }
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
        mutations: items.flatMap((item) => {
          const current = journal.item(journal.canonicalItemId(agentJournalItemKey(item.identity)))
          const body =
            !current || turnRecordReplaceable(current.body, item.body)
              ? item.body
              : withNamedPrompt(current.body, item.body)
          return body
            ? [
                {
                  kind: 'item' as const,
                  ...item,
                  body,
                  turnScope: item.turnScope ?? AGENT_JOURNAL_THREAD_SCOPE
                }
              ]
            : []
        })
      }
    }
  })
}
