import type { Retry } from './structured-agent-session-provider-retry-types'
import { owners } from './structured-agent-session-provider-retry-view'
import { parseAgentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { isRootAgentJournalItem } from '../../../shared/agent-session-journal-producer'
import { isStructuredAgentSessionCommandTurn } from '../../../shared/structured-agent-session-command-entry'
import { latestNativeChatTurnSinceRequest } from '../../../shared/native-chat/native-chat-orca-stop-cut'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { JournalRow } from '../agent-session-journal/journal-row-schema'
import type { StructuredAgentSessionProviderRetry } from './structured-agent-session-provider-retry'

export function observeProviderRetry(
  this: StructuredAgentSessionProviderRetry,
  id: string,
  journal: AgentSessionJournal,
  rows: readonly JournalRow[] = []
): void {
  owners.set(journal, {
    completion: () => {
      const r = this['retries'].get(id)
      return r &&
        this['current'](id, r) &&
        r.phase !== 'candidate' &&
        r.currentResult?.state === 'ended'
        ? { owner: r, itemId: r.currentResult.itemId }
        : null
    },
    finishAborted: () => {
      const r = this['retries'].get(id)
      return !!r?.abort.signal.aborted && this['retire'](id)
    },
    pending: () => {
      const r = this['retries'].get(id)
      return !!r && this['current'](id, r) && (r.phase === 'waiting' || r.phase === 'starting')
    },
    stop: () => {
      const r = this['retries'].get(id)
      return r && this['current'](id, r) && r.currentResult && r.phase !== 'candidate'
        ? { turnId: r.currentResult.turnId, written: r.written }
        : null
    },
    retire: () => this['retire'](id, 'consume'),
    stage: (transition) => this['stage'](id, journal, transition)
  })
  let retry = this['retries'].get(id)
  if (!retry) {
    return
  }
  if (!this['current'](id, retry)) {
    this['retire'](
      id,
      this['deps'].disposed() || journal !== retry.journal || journal.epoch !== retry.epoch
        ? 'abandon'
        : 'release'
    )
    return
  }
  if (
    rows.some(
      (row) =>
        row.kind === 'submission' || (row.kind === 'tombstone' && row.stopEvent !== undefined)
    )
  ) {
    this['retire'](id, 'consume')
    return
  }
  let proofChanged = false
  for (const row of rows) {
    if (row.kind === 'dispatch' || row.kind === 'item' || row.kind === 'lifecycle-batch') {
      proofChanged = true
    }
    if (
      row.kind === 'tombstone' &&
      journal.canonicalItemId(row.itemId) === retry.currentResult?.itemId &&
      !journal.item(row.itemId)
    ) {
      this['retire'](id, 'abandon')
      return
    }
    for (const mutation of row.kind === 'lifecycle-batch' ? row.mutations : [row]) {
      if (mutation.kind !== 'item' || mutation.body.kind !== 'turn') {
        continue
      }
      const turn = mutation.body
      const itemId = journal.canonicalItemId(mutation.itemId)
      const item = journal.item(itemId)
      if (
        !item ||
        !isRootAgentJournalItem(item) ||
        isStructuredAgentSessionCommandTurn(turn, journal.itemBody)
      ) {
        continue
      }
      const offered =
        retry.offered && journal.canonicalItemId(retry.offered.itemId) === itemId
          ? retry.offered
          : undefined
      if (!offered) {
        continue
      }
      const prior = retry.currentResult
      if (retry.phase === 'candidate') {
        if (
          offered.category &&
          turn.state !== 'running' &&
          journal.turnEndedSequence(itemId) === row.seq
        ) {
          retry.currentResult = {
            itemId,
            turnId: turn.turnId,
            sequence: item.sequence,
            state: 'ended',
            role: 'predecessor',
            category: offered.category
          }
        }
        continue
      }
      if (offered.state === 'start') {
        if (!prior || prior.turnId === turn.turnId || item.sequence <= prior.sequence) {
          continue
        }
        if (!retry.written) {
          this['retire'](id)
          return
        }
        this['disposeResult'](id, retry, prior.role === 'predecessor' ? 'consume' : 'release')
        retry.currentResult = {
          itemId,
          turnId: turn.turnId,
          sequence: item.sequence,
          state: 'running',
          role: 'execution'
        }
        if (retry.startedTurnRef && retry.startedTurnRef !== turn.turnId) {
          this['retire'](id)
          return
        }
      } else if (offered.state === 'end' && prior?.turnId === turn.turnId) {
        retry.currentResult = {
          ...prior,
          itemId,
          state: 'ended',
          category: offered.category ?? (prior.state === 'ended' ? prior.category : undefined)
        }
        if (retry.phase === 'running' && retry.startedTurnRef === turn.turnId) {
          this['schedule'](id, retry)
        }
      }
    }
  }
  retry = this['retries'].get(id)
  if (retry?.phase === 'candidate' && proofChanged) {
    this['accept'](id, retry)
  }
}

export function reconcileProviderRetry(
  this: StructuredAgentSessionProviderRetry,
  id: string,
  retry: Retry,
  returned: string
): void {
  const itemId = retry.journal.turnItemId(returned)
  const item = itemId ? retry.journal.item(itemId) : undefined
  const turn = item?.body
  if (
    !item ||
    turn?.kind !== 'turn' ||
    !isRootAgentJournalItem(item) ||
    isStructuredAgentSessionCommandTurn(turn, retry.journal.itemBody)
  ) {
    this['retire'](id)
    return
  }
  const result = retry.currentResult
  if (result?.turnId !== returned) {
    // The reply correlates this invocation; it cannot revive an older execution.
    if (result && result.sequence >= item.sequence) {
      this['retire'](id)
      return
    }
    this['disposeResult'](id, retry, result?.role === 'predecessor' ? 'consume' : 'release')
    retry.currentResult = {
      itemId: item.itemId,
      turnId: returned,
      sequence: item.sequence,
      role: 'execution',
      state: turn.state === 'running' ? 'running' : 'ended'
    }
  } else if (result) {
    result.state = turn.state === 'running' ? 'running' : 'ended'
  }
  retry.phase = 'running'
  if (retry.currentResult?.state === 'ended') {
    this['schedule'](id, retry)
  }
}

export function acceptProviderRetry(
  this: StructuredAgentSessionProviderRetry,
  id: string,
  retry: Retry
): void {
  const terminal = retry.currentResult
  if (!terminal) {
    return
  }
  const turn = retry.journal.itemBody(terminal.itemId)
  if (turn?.kind !== 'turn' || !turn.userItemId) {
    return
  }
  // Only the producer's attributed opener proves a Codex root; an aliased ordinal does not.
  if (
    retry.journal.agent === 'codex' &&
    parseAgentJournalItemKey(turn.userItemId)?.provider !== 'orca'
  ) {
    return
  }
  const identity = parseAgentJournalItemKey(retry.journal.canonicalItemId(turn.userItemId))
  const root =
    identity?.provider === 'orca' ? retry.journal.submission(identity.clientMessageId) : undefined
  if (!root) {
    return
  }
  if (root.answeredInTurn?.via === 'steer' || root.dispatchState === 'rejected') {
    this['retire'](id)
    return
  }
  if (root.dispatchState !== 'accepted') {
    return
  }
  const snapshot = retry.journal.snapshot()
  if (
    latestNativeChatTurnSinceRequest(snapshot.items, snapshot.submissions)?.turnItem.itemId !==
    terminal.itemId
  ) {
    this['retire'](id)
    return
  }
  retry.options = root.options
  this['schedule'](id, retry)
}
