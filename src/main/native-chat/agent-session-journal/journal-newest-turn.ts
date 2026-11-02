import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/agent-session-turn-record'
import { isAgentSessionContextClear } from '../../../shared/agent-session/agent-session-context-clear'
import { parseAgentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { isRootAgentJournalItem } from '../../../shared/agent-session/journal/agent-session-journal-producer'
import { isStructuredAgentSessionCommandTurnId } from '../agent-session-wire/structured-agent-session-command-turn'
import type { JournalReducerState } from './journal-reducer'
import type { JournalRow } from './journal-row-schema'
import {
  compareTurnSources,
  putTurnSource,
  type TurnSource,
  type TurnSourceNode
} from './journal-newest-turn-tree'

/** Owned by the transaction-isolated input order; never saved beside the journal. Every turn and
 * clear sits in a creation-ordered tree, so each row updates only the sources it touches. */
export class JournalNewestTurn {
  private root: TurnSourceNode | undefined
  private readonly sources = new Map<string, TurnSource>()
  /** Agent failure rows (usage limit, sign-in, terminal error) and the turn each reports on,
   * indexed whether or not that turn has arrived yet. */
  private readonly evidence = new Map<string, string>()
  private readonly reports = new Map<string, number>()
  /** Settlement order at or before this row is unknown (restore, or removal of a source that could
   * decide), so a failure seen earlier holds until a Resume written after it. */
  private boundary: number

  /** Only on restore; streamed rows never rescan conversation history. */
  constructor(state: JournalReducerState) {
    this.boundary = state.lastSequence
    const turns: AgentJournalRenderItem[] = []
    const reported = new Set<string>()
    for (const item of state.items.values()) {
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
    return this.root?.latest.item ?? null
  }

  /** Releasing Resume marks must be written after this position. */
  failure(): number {
    const failedAt = this.root?.winner?.failedAt ?? 0
    return failedAt && Math.max(failedAt, this.boundary)
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
      const prior = this.sources.get(itemId)
      if (prior && !isTurnOrClear(item)) {
        // Removing one at or after the newest ordinary turn or clear exposes what lies beneath.
        const anchor = this.root?.anchor
        if (!anchor || compareTurnSources(prior, anchor) >= 0) {
          this.boundary = row.seq
        }
        this.sources.delete(itemId)
        this.root = putTurnSource(this.root, prior, true)
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
    const prior = this.sources.get(item.itemId)
    const command = isCommand(item)
    const failed = settledFailure(item)
    const reported = (this.reports.get(item.itemId) ?? 0) > 0
    const source: TurnSource = {
      item,
      failedAt: failed && (!command || reported) ? prior?.failedAt || at : 0,
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
    if (prior && compareTurnSources(prior, source) !== 0) {
      this.root = putTurnSource(this.root, prior, true)
    }
    this.sources.set(item.itemId, source)
    this.root = putTurnSource(this.root, source, false)
  }

  private index(
    state: JournalReducerState,
    itemId: string,
    item: AgentJournalRenderItem | undefined,
    touched: Set<string>
  ): void {
    const turn = item ? reportedTurn(state, item) : null
    const prior = this.evidence.get(itemId) ?? null
    if (turn === prior) {
      return
    }
    for (const [target, step] of [
      [prior, -1],
      [turn, 1]
    ] as const) {
      if (target !== null) {
        const count = (this.reports.get(target) ?? 0) + step
        if (count > 0) {
          this.reports.set(target, count)
        } else {
          this.reports.delete(target)
        }
        touched.add(target)
      }
    }
    if (turn === null) {
      this.evidence.delete(itemId)
    } else {
      this.evidence.set(itemId, turn)
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
