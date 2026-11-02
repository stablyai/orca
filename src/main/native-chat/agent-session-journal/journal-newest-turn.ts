import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/agent-session-turn-record'
import { isAgentSessionContextClear } from '../../../shared/agent-session/agent-session-context-clear'
import { compareAgentJournalItems } from '../../../shared/agent-session/journal/agent-session-journal-position'
import { parseAgentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { isRootAgentJournalItem } from '../../../shared/agent-session/journal/agent-session-journal-producer'
import { isStructuredAgentSessionCommandTurnId } from '../agent-session-wire/structured-agent-session-command-turn'
import type { JournalReducerState } from './journal-reducer'
import type { JournalRow } from './journal-row-schema'

/** A turn or context clear that can decide the failure hold, with the row where it first became a
 * holding failure (zero while it is not one). */
type Source = { item: AgentJournalRenderItem; failedAt: number }

/** Owned by the transaction-isolated input order; never saved beside the journal. */
export class JournalNewestTurn {
  private latest: AgentJournalRenderItem | null = null
  /** Newest ordinary turn or context clear: always decides when nothing newer does. */
  private anchor: Source | null = null
  /** Command turns created after the anchor. One that failed on its own terms (refused, or its
   * own verdict) is see-through: it neither holds nor releases. */
  private readonly commands = new Map<string, Source>()
  /** Agent failure rows (usage limit, sign-in, terminal error) and the turn each reports on,
   * indexed whether or not that turn has arrived yet. */
  private readonly evidence = new Map<string, string>()
  private readonly reports = new Map<string, number>()
  private source: string | null = null

  constructor(state: JournalReducerState) {
    this.rebuild(state, state.lastSequence)
  }

  read(): AgentJournalRenderItem | null {
    return this.latest
  }

  /** Releasing Resume marks must be written after this position. */
  failure(): number {
    const id = this.source
    return id === null ? 0 : ((this.commands.get(id) ?? this.anchor)?.failedAt ?? 0)
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
      if (!isTurnOrClear(item) && this.tracks(itemId)) {
        // Order of what lies beneath is unknown; rebuild at a fixed boundary.
        this.rebuild(state, row.seq)
        return
      }
      this.observe(item)
      this.index(state, itemId, item, touched)
      if (item && isTurnOrClear(item)) {
        touched.add(itemId)
      }
    }
    let changed = false
    for (const itemId of touched) {
      changed = this.place(state.items.get(itemId), row.seq) || changed
    }
    if (changed) {
      this.source = this.pick()
    }
  }

  /** Only on restore/removal; streamed rows never rescan conversation history. Settlement order is
   * not saved, so a failure found here holds until a Resume written after `at`. */
  private rebuild(state: JournalReducerState, at: number): void {
    this.latest = null
    this.anchor = null
    this.commands.clear()
    this.evidence.clear()
    this.reports.clear()
    const commands: AgentJournalRenderItem[] = []
    const reported = new Set<string>()
    for (const item of state.items.values()) {
      this.observe(item)
      this.index(state, item.itemId, item, reported)
      if (isCommand(item)) {
        commands.push(item)
      } else if (isTurnOrClear(item)) {
        this.place(item, at)
      }
    }
    for (const item of commands) {
      this.place(item, at)
    }
    this.source = this.pick()
  }

  private tracks(itemId: string): boolean {
    return (
      this.latest?.itemId === itemId ||
      this.anchor?.item.itemId === itemId ||
      this.commands.has(itemId)
    )
  }

  private observe(item: AgentJournalRenderItem | undefined): void {
    if (
      item &&
      isTurnOrClear(item) &&
      (!this.latest || compareAgentJournalItems(item, this.latest) >= 0)
    ) {
      this.latest = item
    }
  }

  /** Re-derives one candidate; returns whether it can change the source. */
  private place(item: AgentJournalRenderItem | undefined, at: number): boolean {
    if (!item || !isTurnOrClear(item)) {
      return false
    }
    const anchor = this.anchor
    if (
      anchor &&
      anchor.item.itemId !== item.itemId &&
      compareAgentJournalItems(item, anchor.item) < 0
    ) {
      return false
    }
    if (isCommand(item)) {
      this.commands.set(item.itemId, this.settle(item, this.commands.get(item.itemId), at))
      return true
    }
    this.anchor = this.settle(item, anchor?.item.itemId === item.itemId ? anchor : undefined, at)
    for (const [itemId, command] of this.commands) {
      if (compareAgentJournalItems(command.item, item) < 0) {
        this.commands.delete(itemId)
      }
    }
    return true
  }

  /** Keeps the first failure position across same-failure revisions; leaving failure clears it. */
  private settle(item: AgentJournalRenderItem, prior: Source | undefined, at: number): Source {
    const holds = settledFailure(item) && (!isCommand(item) || this.reported(item))
    return { item, failedAt: holds ? prior?.failedAt || at : 0 }
  }

  private pick(): string | null {
    let source = this.anchor
    for (const command of this.commands.values()) {
      const seeThrough = settledFailure(command.item) && !this.reported(command.item)
      if (!seeThrough && (!source || compareAgentJournalItems(command.item, source.item) > 0)) {
        source = command
      }
    }
    return source?.item.itemId ?? null
  }

  private reported(item: AgentJournalRenderItem): boolean {
    return (this.reports.get(item.itemId) ?? 0) > 0
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
