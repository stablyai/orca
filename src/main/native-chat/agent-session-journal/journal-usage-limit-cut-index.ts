import { isPublicJournalExecution } from './journal-execution-view'
import { journalChangedItemIds } from './journal-item-address'
import { isRootAgentJournalItem } from '../../../shared/agent-session/journal/agent-session-journal-producer'
import {
  readAgentJournalTurn,
  readAgentJournalTurnOutcome
} from '../../../shared/agent-session/lifecycle/agent-session-turn-record'
import { agentTurnVerdict } from '../../../shared/agent-turn-outcome'
import { isStructuredAgentSessionCommandTurn } from '../../../shared/agent-session/structured-agent-session-command-entry'
import { isStructuredAgentSessionNonRequestRow } from '../../../shared/agent-session/requests/structured-agent-session-latest-request'
import { readAgentSessionFailureFact } from '../../../shared/agent-session/failures/agent-session-failure'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { JournalReducerState } from './journal-reducer'
import type { JournalRow } from './journal-row-schema'
import { putTurnSource, type TurnSource, type TurnSourceNode } from './journal-newest-turn-tree'

/** Mirrors the public latest-cut predicate with point updates, never a stream-time history scan. */
export class JournalUsageLimitCutIndex {
  private root: TurnSourceNode | undefined
  private sources = new Map<string, TurnSource>()
  private reports = new Map<string, { target: string; source: TurnSource }>()
  private limits = new Map<string, TurnSourceNode | undefined>()
  private dependents = new Map<string, Set<string>>()
  private dependency = new Map<string, string>()
  private heads = new Map<string, string>()
  constructor(state: JournalReducerState) {
    for (const itemId of state.items.keys()) {
      this.update(state, itemId)
    }
  }

  afterRow(state: JournalReducerState, row: JournalRow): void {
    const ids =
      row.kind === 'submission' || row.kind === 'dispatch'
        ? [agentJournalSubmissionKey(row.clientMessageId)]
        : journalChangedItemIds(state, row)
    const changed = new Set(ids)
    const mutations =
      row.kind === 'item' || row.kind === 'tombstone'
        ? [row]
        : row.kind === 'lifecycle-batch'
          ? row.mutations
          : []
    for (const mutation of mutations) {
      changed.add(mutation.itemId)
      const provider =
        mutation.kind === 'item' && readAgentJournalTurn(mutation.body)
          ? (mutation.executionOrigin?.providerItemId ?? mutation.itemId)
          : undefined
      if (provider !== undefined) {
        changed.add(provider)
        const previous = this.heads.get(provider)
        if (previous !== undefined) {
          changed.add(previous)
        }
        const next = state.aliases.get(provider) ?? provider
        changed.add(next)
        this.heads.set(provider, next)
      }
    }
    for (const id of changed) {
      this.update(state, id)
      // update removes and re-adds dependencies, so iterate a stable snapshot.
      const dependents = Array.from(this.dependents.get(id) ?? [])
      for (const dependent of dependents) {
        this.update(state, dependent)
      }
    }
  }
  read() {
    const item = this.root?.latest.item
    const turn = readAgentJournalTurn(item?.body)
    if (
      !item ||
      !turn ||
      agentTurnVerdict({ state: turn.state, outcome: readAgentJournalTurnOutcome(turn) }) !==
        'failure'
    ) {
      return undefined
    }
    let limit = this.limits.get(item.itemId)
    while (limit?.left) {
      limit = limit.left
    }
    const body = limit?.source.item.body
    const fact = body?.kind === 'status' ? readAgentSessionFailureFact(body.failure) : null
    const resetsAt = fact?.kind === 'usageLimitReached' ? fact.usageLimit?.resetsAt : undefined
    return resetsAt !== undefined && Number.isFinite(resetsAt)
      ? { turnItemId: item.itemId, resetsAt }
      : undefined
  }
  private update(state: JournalReducerState, itemId: string): void {
    const item = state.items.get(itemId)
    const turn = readAgentJournalTurn(item?.body)
    if (turn && item) {
      const provider = item.executionOrigin?.providerItemId ?? item.itemId
      this.heads.set(provider, state.aliases.get(provider) ?? provider)
    }
    const previousDependency = this.dependency.get(itemId)
    if (previousDependency !== undefined) {
      const users = this.dependents.get(previousDependency)
      users?.delete(itemId)
      if (users?.size === 0) {
        this.dependents.delete(previousDependency)
      }
      this.dependency.delete(itemId)
    }
    if (turn?.userItemId !== undefined) {
      const id = state.aliases.get(turn.userItemId) ?? turn.userItemId
      let users = this.dependents.get(id)
      if (!users) {
        users = new Set()
        this.dependents.set(id, users)
      }
      users.add(itemId)
      this.dependency.set(itemId, id)
    }
    const commandTurns = {
      has: (id: string) =>
        isStructuredAgentSessionCommandTurn(
          readAgentJournalTurn(state.items.get(id)?.body),
          (key) => state.items.get(state.aliases.get(key) ?? key)?.body
        )
    }
    const relevant =
      item &&
      isRootAgentJournalItem(item) &&
      isPublicJournalExecution(state, item) &&
      !isStructuredAgentSessionNonRequestRow(item, commandTurns) &&
      (turn || (item.body.kind === 'message' && item.body.role === 'user'))
    const previous = this.sources.get(itemId)
    if (previous) {
      this.root = putTurnSource(this.root, previous, true)
    }
    if (relevant) {
      const source = { item, failedAt: 0, ordinary: true, relevant: true }
      this.sources.set(itemId, source)
      this.root = putTurnSource(this.root, source, false)
    } else {
      this.sources.delete(itemId)
    }
    const prior = this.reports.get(itemId)
    if (prior) {
      this.limits.set(
        prior.target,
        putTurnSource(this.limits.get(prior.target), prior.source, true)
      )
      this.reports.delete(itemId)
    }
    const fact =
      item?.body.kind === 'status' ? readAgentSessionFailureFact(item.body.failure) : null
    if (
      item &&
      isRootAgentJournalItem(item) &&
      item.turnScope?.kind === 'turn' &&
      fact?.kind === 'usageLimitReached'
    ) {
      const target = item.turnScope.turnItemId
      const source = { item, failedAt: 0, ordinary: true, relevant: true }
      this.reports.set(itemId, { target, source })
      this.limits.set(target, putTurnSource(this.limits.get(target), source, false))
    }
  }
}
