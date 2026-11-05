import { memoryJournalMap } from './journal-memory-collections'
import { isDeepStrictEqual } from 'node:util'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/agent-session-turn-record'
import { isAgentSessionContextClear } from '../../../shared/agent-session/agent-session-context-clear'
import { parseAgentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import {
  agentJournalLinkageFields,
  isRootAgentJournalItem
} from '../../../shared/agent-session/journal/agent-session-journal-producer'
import { isStructuredAgentSessionCommandTurnId } from '../agent-session-wire/structured-agent-session-command-turn'
import type { JournalReducerState } from './journal-reducer'
import type { JournalRow } from './journal-row-schema'
import { compareTurnSources, type TurnSource } from './journal-newest-turn-tree'
import type { JournalNewestTurnStorage } from './journal-index-storage'
import { memoryJournalIndexStorage } from './journal-memory-index-storage'

/** The input owner updates only touched turn sources; storage supplies creation-order queries. */
export class JournalNewestTurn {
  /** Only on restore; streamed rows never rescan conversation history. */
  constructor(
    state: JournalReducerState,
    private readonly storage: JournalNewestTurnStorage = memoryJournalIndexStorage.newestTurn()
  ) {
    if (!storage.initializeFromItems) {
      return
    }
    this.storage.boundary = state.lastSequence
    const turns: AgentJournalRenderItem[] = []
    const reported = new Set<string>()
    for (const item of memoryJournalMap(state.items).values()) {
      this.index(state, item.itemId, item, reported)
      if (isTurnOrClear(item)) {
        turns.push(item)
      }
    }
    for (const item of turns) {
      this.place(item, state.lastSequence)
    }
  }

  read(): AgentJournalRenderItem | null {
    return this.storage.sources.latest()?.item ?? null
  }

  /** Releasing Resume marks must be written after this position. */
  failure(): number {
    const winner = this.storage.sources.winner()
    const failedAt = winner?.failedAt ?? 0
    return (
      failedAt &&
      Math.max(
        failedAt,
        this.storage.boundary > (winner?.witnessedThrough ?? 0) ? this.storage.boundary : 0
      )
    )
  }

  /** Only known, unchanged retained sources can carry chronology across presentation rebuilding. */
  retainFailures(
    state: JournalReducerState,
    itemIds: readonly string[]
  ): (next: JournalNewestTurn, state: JournalReducerState) => void {
    const failures = itemIds.flatMap((id) => {
      const source = this.storage.sources.get(id)
      return source?.failedAt
        ? [
            {
              source,
              at: Math.max(
                source.failedAt,
                this.storage.boundary > (source.witnessedThrough ?? 0) ? this.storage.boundary : 0
              ),
              reports: this.storage.reports.get(id) ?? 0
            }
          ]
        : []
    })
    const evidence = itemIds.flatMap((id) => {
      const target = this.storage.evidence.get(id)
      const item = state.items.get(id)
      return target && item ? [{ id, target, item }] : []
    })
    return (next, current) => {
      const unchanged = new Map<string, number>()
      for (const { id, target, item } of evidence) {
        const kept = current.items.get(id)
        if (
          next.storage.evidence.get(id) === target &&
          kept &&
          isDeepStrictEqual(item.body, kept.body) &&
          isDeepStrictEqual(item.turnScope, kept.turnScope) &&
          isDeepStrictEqual(agentJournalLinkageFields(item), agentJournalLinkageFields(kept))
        ) {
          unchanged.set(target, (unchanged.get(target) ?? 0) + 1)
        }
      }
      for (const { source, at, reports } of failures) {
        const kept = next.storage.sources.get(source.item.itemId)
        if (
          !kept?.failedAt ||
          !isDeepStrictEqual(source.item.body, kept.item.body) ||
          !isDeepStrictEqual(source.item.turnScope, kept.item.turnScope) ||
          !isDeepStrictEqual(
            agentJournalLinkageFields(source.item),
            agentJournalLinkageFields(kept.item)
          ) ||
          source.ordinary !== kept.ordinary ||
          source.relevant !== kept.relevant ||
          (next.storage.reports.get(source.item.itemId) ?? 0) !== reports ||
          (unchanged.get(source.item.itemId) ?? 0) !== reports
        ) {
          continue
        }
        const retained = { ...kept, failedAt: at, witnessedThrough: next.storage.boundary }
        next.storage.sources.set(kept.item.itemId, retained)
      }
    }
  }

  afterRow(state: JournalReducerState, row: JournalRow): void {
    const itemIds =
      row.kind === 'item' || row.kind === 'tombstone'
        ? [row.itemId]
        : row.kind === 'lifecycle-batch'
          ? row.mutations.map((mutation) => mutation.itemId)
          : []
    const touched = new Set<string>()
    for (const raw of itemIds) {
      const itemId = state.aliases.get(raw) ?? raw
      const item = state.items.get(itemId)
      const prior = this.storage.sources.get(itemId)
      if (prior && !isTurnOrClear(item)) {
        // Removing one at or after the newest ordinary turn or clear exposes what lies beneath.
        const anchor = this.storage.sources.anchor()
        if (!anchor || compareTurnSources(prior, anchor) >= 0) {
          this.storage.boundary = row.seq
        }
        this.storage.sources.delete(itemId)
      }
      this.index(state, itemId, item, touched)
      if (isTurnOrClear(item)) {
        touched.add(itemId)
      }
    }
    for (const itemId of touched) {
      this.place(state.items.get(itemId), row.seq)
    }
  }

  /** Keeps the first failure position across same-failure revisions; leaving failure clears it. */
  private place(item: AgentJournalRenderItem | undefined, at: number): void {
    if (!item || !isTurnOrClear(item)) {
      return
    }
    const prior = this.storage.sources.get(item.itemId)
    const command = isCommand(item)
    const failed = settledFailure(item)
    const reported = (this.storage.reports.get(item.itemId) ?? 0) > 0
    const source: TurnSource = {
      item,
      failedAt: failed && (!command || reported) ? prior?.failedAt || at : 0,
      ...(failed && prior?.failedAt && isDeepStrictEqual(prior.item.body, item.body)
        ? { witnessedThrough: prior.witnessedThrough }
        : {}),
      ordinary: !command,
      relevant: !command || !failed || reported
    }
    if (
      prior?.item === item &&
      prior.failedAt === source.failedAt &&
      prior.ordinary === source.ordinary &&
      prior.relevant === source.relevant
    ) {
      return
    }
    this.storage.sources.set(item.itemId, source)
  }

  private index(
    state: JournalReducerState,
    itemId: string,
    item: AgentJournalRenderItem | undefined,
    touched: Set<string>
  ): void {
    const turn = item ? reportedTurn(state, item) : null
    const prior = this.storage.evidence.get(itemId) ?? null
    if (turn === prior) {
      return
    }
    for (const [target, step] of [
      [prior, -1],
      [turn, 1]
    ] as const) {
      if (target !== null) {
        const count = (this.storage.reports.get(target) ?? 0) + step
        if (count > 0) {
          this.storage.reports.set(target, count)
        } else {
          this.storage.reports.delete(target)
        }
        touched.add(target)
      }
    }
    if (turn === null) {
      this.storage.evidence.delete(itemId)
    } else {
      this.storage.evidence.set(itemId, turn)
    }
  }
}

function isTurnOrClear(item: AgentJournalRenderItem | undefined): boolean {
  return !!item && (!!readAgentJournalTurn(item.body) || isAgentSessionContextClear(item.body))
}

function settledFailure(item: AgentJournalRenderItem): boolean {
  const turn = readAgentJournalTurn(item.body)
  return turn?.state !== 'running' && turn?.outcome === 'failure'
}

/** A command turn holds the queue only with an agent failure row in its turn. */
function isCommand(item: AgentJournalRenderItem): boolean {
  const turnId = readAgentJournalTurn(item.body)?.turnId
  return !!turnId && isStructuredAgentSessionCommandTurnId(turnId)
}

/** A command's own verdict, whichever writer saved it, and a retry still under way are not the
 * agent reporting a failure. */
const NOT_REPORTS: ReadonlySet<string> = new Set([
  'compactionFailed',
  'compactionUnconfirmed',
  'commandRefused',
  'providerRetrying'
])

/** The turn a root failure row reports for, unless it is a command's own verdict: one of the kinds
 * above, or anything Orca wrote on a command's result identity (its refusals). */
function reportedTurn(state: JournalReducerState, item: AgentJournalRenderItem): string | null {
  const { body, turnScope } = item
  if (
    body.kind !== 'status' ||
    turnScope?.kind !== 'turn' ||
    !isRootAgentJournalItem(item) ||
    !(body.failure ? !NOT_REPORTS.has(body.failure.kind) : body.tone === 'error')
  ) {
    return null
  }
  const identity = parseAgentJournalItemKey(item.itemId)
  if (identity?.provider === 'orca' && identity.clientMessageId.startsWith('command-result:')) {
    return null
  }
  return state.aliases.get(turnScope.turnItemId) ?? turnScope.turnItemId
}
