import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/agent-session-turn-record'
import { isAgentSessionContextClear } from '../../../shared/agent-session/agent-session-context-clear'
import { compareAgentJournalItems } from '../../../shared/agent-session/journal/agent-session-journal-position'
import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { isRootAgentJournalItem } from '../../../shared/agent-session/journal/agent-session-journal-producer'
import { structuredAgentSessionCommandTurn } from '../../../shared/agent-session/view/structured-agent-session-command-turn-identity'
import { isStructuredAgentSessionCommandTurnId } from '../agent-session-wire/structured-agent-session-command-turn'
import type { JournalReducerState } from './journal-reducer'
import type { JournalRow } from './journal-row-schema'

/** Owned by the transaction-isolated input order; never saved beside the journal. */
export class JournalNewestTurn {
  private latest: AgentJournalRenderItem | null = null
  /** Row where the newest turn first settled as failed; zero while it has not. Each turn row
   * re-derives it from the newest outcome, and restore or removal rebuilds it. */
  private failedAt = 0
  /** A command that failed on its own terms (refused, or its own verdict) is see-through: the
   * failure position beneath it, taken when it became newest, stays in force. */
  private beneath = 0
  /** The agent's own failure row in the newest command's turn (usage limit, terminal error). */
  private reported: string | null = null

  constructor(state: JournalReducerState) {
    this.rebuild(state, state.lastSequence)
  }

  read(): AgentJournalRenderItem | null {
    return this.latest
  }

  /** Releasing Resume marks must be written after this position. */
  failure(): number {
    return this.seeThrough() ? this.beneath : this.failedAt
  }

  afterRow(state: JournalReducerState, row: JournalRow): void {
    const itemIds =
      row.kind === 'item' || row.kind === 'tombstone'
        ? [row.itemId]
        : row.kind === 'lifecycle-batch'
          ? row.mutations.map((mutation) => mutation.itemId)
          : []
    if (itemIds.length === 0) {
      return
    }
    const previous = this.latest
    const before = this.failure()
    let removed = false
    for (const itemId of itemIds) {
      removed = this.refresh(state, itemId) || removed
    }
    const replaced = previous?.itemId !== this.latest?.itemId
    if (replaced) {
      this.beneath = before
      this.reported = null
    }
    // Agent failure rows may land after their command settled; they re-derive the hold here.
    for (const itemId of itemIds) {
      removed = this.observeReport(state, state.aliases.get(itemId) ?? itemId) || removed
    }
    if (removed) {
      this.rebuild(state, row.seq)
    } else if (!this.holds()) {
      this.failedAt = 0
    } else if (!this.failedAt || replaced) {
      this.failedAt = row.seq
    }
  }

  /** Only on restore/removal; streamed rows never rescan conversation history. Settlement order is
   * not saved, so a failure found here holds until a Resume written after `at`. */
  private rebuild(state: JournalReducerState, at: number): void {
    const reports = new Map<string, string>()
    for (const item of state.items.values()) {
      const turnItemId = reportedCommandTurn(state, item)
      if (turnItemId) {
        reports.set(turnItemId, item.itemId)
      }
    }
    this.latest = null
    let source: AgentJournalRenderItem | null = null
    for (const item of state.items.values()) {
      this.observe(item)
      if (
        isTurnOrClear(item) &&
        (!ownFailure(item) || reports.has(item.itemId)) &&
        (!source || compareAgentJournalItems(item, source) >= 0)
      ) {
        source = item
      }
    }
    this.reported = (this.latest && reports.get(this.latest.itemId)) ?? null
    this.failedAt = this.holds() ? at : 0
    this.beneath = settledFailure(source) ? at : 0
  }

  private holds(): boolean {
    return settledFailure(this.latest) && !this.seeThrough()
  }

  private seeThrough(): boolean {
    return ownFailure(this.latest) && this.reported === null
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

  /** True when the newest item was removed or stopped being a turn. */
  private refresh(state: JournalReducerState, itemId: string): boolean {
    itemId = state.aliases.get(itemId) ?? itemId
    const item = state.items.get(itemId)
    if (this.latest?.itemId === itemId && !isTurnOrClear(item)) {
      return true
    }
    this.observe(item)
    return false
  }

  /** True when the agent failure row the hold rests on was removed or stopped reporting. */
  private observeReport(state: JournalReducerState, itemId: string): boolean {
    const item = state.items.get(itemId)
    const reports = item !== undefined && reportedCommandTurn(state, item) === this.latest?.itemId
    if (reports) {
      this.reported ??= itemId
    }
    return !reports && this.reported === itemId
  }
}

function isTurnOrClear(item: AgentJournalRenderItem | undefined): boolean {
  return !!item && (!!readAgentJournalTurn(item.body) || isAgentSessionContextClear(item.body))
}

function settledFailure(item: AgentJournalRenderItem | null): boolean {
  const turn = readAgentJournalTurn(item?.body)
  return turn?.state !== 'running' && turn?.outcome === 'failure'
}

/** A failed command turn; it holds the queue only with an agent failure row in its turn. */
function ownFailure(item: AgentJournalRenderItem | null): boolean {
  return settledFailure(item) && commandResultItemId(item) !== null
}

function commandResultItemId(item: AgentJournalRenderItem | null | undefined): string | null {
  const turnId = readAgentJournalTurn(item?.body)?.turnId
  return turnId && isStructuredAgentSessionCommandTurnId(turnId)
    ? agentJournalItemKey(
        structuredAgentSessionCommandTurn(turnId.slice('compact:'.length)).resultIdentity
      )
    : null
}

/** The command turn a root failure row reports for, unless it is the command's own verdict or
 * Orca's refusal (both written on the command's result identity). */
function reportedCommandTurn(
  state: JournalReducerState,
  item: AgentJournalRenderItem
): string | null {
  const { body, turnScope } = item
  if (
    body.kind !== 'status' ||
    turnScope?.kind !== 'turn' ||
    !isRootAgentJournalItem(item) ||
    !(body.failure ? body.failure.kind !== 'providerRetrying' : body.tone === 'error')
  ) {
    return null
  }
  const turnItemId = state.aliases.get(turnScope.turnItemId) ?? turnScope.turnItemId
  const result = commandResultItemId(state.items.get(turnItemId))
  return result !== null && result !== item.itemId ? turnItemId : null
}
