import { agentJournalSubmissionProvenUnwritten } from '../../../shared/agent-session/requests/agent-session-queued-submission'
import {
  agentJournalSubmissionKey,
  parseAgentJournalItemKey
} from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/agent-session-turn-record'
import type { AgentJournalSubmission } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalReducerState } from './journal-reducer'
import { journalItemExecutionFence } from './journal-item-provenance'
import type { JournalOwnedItem } from './journal-execution-interruption'
import type { PendingCancellation } from './journal-stop-cancellation'

export type JournalCancellationTarget = {
  ownerFence: number
  executionId?: string
  turnId?: string
  clientMessageId?: string
}
export function turnOpeningClientId(
  state: Pick<JournalReducerState, 'aliases'>,
  userItemId?: string
): string | undefined {
  if (userItemId === undefined) {
    return undefined
  }
  const identity = parseAgentJournalItemKey(state.aliases.get(userItemId) ?? userItemId)
  return identity?.provider === 'orca' && 'clientMessageId' in identity
    ? identity.clientMessageId
    : undefined
}
type ExecutionTurn = { itemId: string; target: JournalCancellationTarget; active: boolean }

/** Canonical execution identity owns history; native names select only the current generation. */
export class JournalCancellationTargets {
  private turns = new Map<string, ExecutionTurn>()
  private heads = new Map<string, string>()
  private roots = new Map<string, string>()
  private linked = new Map<string, string>()
  private anchors = new Map<string, string>()
  private aliases = new Map<string, string[]>()
  private rawLinks = new Map<string, string>()
  private openers = new Map<string, JournalCancellationTarget>()
  private active = new Map<string, JournalCancellationTarget>()
  private requests = new Map<string, PendingCancellation>()
  private retained = new Map<string, JournalCancellationTarget>()

  turn(turnId: string): JournalCancellationTarget | undefined {
    const id = this.heads.get(turnId)
    return id === undefined ? undefined : this.turns.get(id)?.target
  }
  forItem(itemId: string): JournalCancellationTarget | undefined {
    const id = this.roots.get(itemId) ?? this.linked.get(itemId)
    return id === undefined ? this.openers.get(itemId) : this.turns.get(id)?.target
  }
  turnItem(turnId: string): string | undefined {
    const id = this.heads.get(turnId)
    return id === undefined ? undefined : this.turns.get(id)?.itemId
  }
  executionItem(target: JournalCancellationTarget): string | undefined {
    return target.executionId === undefined ? undefined : this.turns.get(target.executionId)?.itemId
  }
  openerTurn(clientMessageId: string): string | undefined {
    const id = this.linked.get(agentJournalSubmissionKey(clientMessageId))
    return id === undefined ? undefined : this.turns.get(id)?.target.turnId
  }
  restoreBinding(root: string, opener: string): void {
    this.roots.set(root, opener)
    this.linked.set(opener, opener)
  }
  restoreOwner(item: JournalOwnedItem): void {
    const fact = item.executionInterruption
    if (!fact) {
      return
    }
    const id = fact.target.executionId ?? fact.owner.itemId
    this.retained.set(item.itemId, { ...fact.target, executionId: id })
    this.anchors.set(id, item.itemId)
  }
  anchor(target: JournalCancellationTarget): string | undefined {
    const id = target.executionId
    if (id !== undefined && this.anchors.has(id)) {
      return this.anchors.get(id)
    }
    if (target.clientMessageId !== undefined) {
      return agentJournalSubmissionKey(target.clientMessageId)
    }
    const canonical = target.turnId === undefined ? undefined : this.turn(target.turnId)
    return canonical?.executionId === undefined
      ? undefined
      : this.anchors.get(canonical.executionId)
  }
  history(state: JournalReducerState, itemOrTurnId: string) {
    const id =
      this.roots.get(itemOrTurnId) ?? this.linked.get(itemOrTurnId) ?? this.heads.get(itemOrTurnId)
    const anchor = id === undefined ? undefined : this.anchors.get(id)
    const fact = anchor === undefined ? undefined : state.items.get(anchor)?.executionInterruption
    return fact && (fact.target.executionId ?? fact.owner.itemId) === id ? fact : undefined
  }
  pending(): PendingCancellation[] {
    return [...this.requests.values()]
  }
  unresolved(): JournalCancellationTarget[] {
    return [...this.active.values()]
  }

  observeTurn(state: JournalReducerState, item: JournalOwnedItem): void {
    this.restoreOwner(item)
    const turn = readAgentJournalTurn(item.body)
    if (!turn) {
      const fact = item.executionInterruption
      if (fact && fact.target.turnId === undefined && fact.target.clientMessageId !== undefined) {
        const target = { ...fact.target, executionId: fact.target.executionId ?? fact.owner.itemId }
        this.openers.set(item.itemId, target)
        this.active.set(target.executionId, target)
      }
      this.refresh(state, item.itemId)
      return
    }
    const ownerFence = journalItemExecutionFence(state, item.itemId) ?? 0
    const prior = this.roots.get(item.itemId)
    const priorLife = prior === undefined ? undefined : this.turns.get(prior)
    const clientMessageId =
      turnOpeningClientId(state, turn.userItemId) ??
      priorLife?.target.clientMessageId ??
      (prior === undefined ? undefined : this.retained.get(prior)?.clientMessageId) ??
      item.executionInterruption?.target.clientMessageId
    const openerKey =
      clientMessageId === undefined ? undefined : agentJournalSubmissionKey(clientMessageId)
    const opener = openerKey === undefined ? undefined : state.items.get(openerKey)
    const saved =
      this.retained.get(item.itemId) ??
      (openerKey === undefined ? undefined : this.retained.get(openerKey))
    const linked = openerKey === undefined ? undefined : this.linked.get(openerKey)
    const ownsOpener =
      opener &&
      (linked === undefined || linked === prior) &&
      (journalItemExecutionFence(state, opener.itemId) ?? ownerFence) === ownerFence
    const id =
      prior ??
      (saved?.ownerFence === ownerFence ? saved.executionId : undefined) ??
      (ownsOpener ? opener.itemId : item.itemId)
    const target: JournalCancellationTarget = {
      executionId: id,
      turnId: turn.turnId,
      ownerFence,
      ...(clientMessageId === undefined ? {} : { clientMessageId })
    }
    const rememberedAnchor = this.anchors.get(id)
    const anchorId = ownsOpener
      ? opener.itemId
      : rememberedAnchor && state.items.has(rememberedAnchor)
        ? rememberedAnchor
        : item.itemId
    this.roots.set(item.itemId, id)
    this.anchors.set(id, anchorId)
    const active = turn.state === 'running' || turn.state === 'unverifiable'
    this.turns.set(id, { itemId: item.itemId, target, active })
    const providerId = item.executionOrigin?.providerItemId ?? item.itemId
    if ((state.aliases.get(providerId) ?? providerId) === item.itemId) {
      this.heads.set(turn.turnId, id)
    }
    if (turn.userItemId !== undefined) {
      this.rawLinks.set(turn.userItemId, id)
    }
    if (openerKey !== undefined && (linked === undefined || linked === id)) {
      this.linked.set(openerKey, id)
      this.openers.delete(openerKey)
      this.active.delete(openerKey)
    }
    if (active) {
      this.active.set(id, target)
    } else {
      this.active.delete(id)
    }
    const anchor = state.items.get(anchorId)
    const fact = anchor?.executionInterruption ?? item.executionInterruption
    if (fact && anchor && (fact.target.executionId ?? fact.owner.itemId) === id) {
      if (anchorId !== item.itemId && item.executionInterruption) {
        const { executionInterruption: _moved, ...provider } = item
        state.items.set(item.itemId, provider)
      }
      state.items.set(anchorId, {
        ...anchor,
        executionInterruption: { ...fact, target: { ...target } }
      })
    }
    this.refresh(state, anchorId)
  }

  observeSubmission(
    state: JournalReducerState,
    submission: AgentJournalSubmission,
    item?: JournalOwnedItem
  ): void {
    const key = agentJournalSubmissionKey(submission.clientMessageId)
    const rawId =
      submission.providerItemId === null ? undefined : this.rawLinks.get(submission.providerItemId)
    const rawRoot = rawId === undefined ? undefined : this.turns.get(rawId)?.itemId
    const rawItem = rawRoot === undefined ? undefined : state.items.get(rawRoot)
    if (rawItem) {
      this.observeTurn(state, rawItem)
    }
    const opener = item ?? state.items.get(key)
    if (
      this.linked.has(key) ||
      (submission.dispatchState === 'rejected' &&
        agentJournalSubmissionProvenUnwritten(submission)) ||
      opener?.turnScope?.kind === 'turn'
    ) {
      this.openers.delete(key)
      this.active.delete(key)
    } else if (opener && (submission.handedOverAt !== undefined || !submission.handoverRecorded)) {
      const target = {
        executionId: key,
        ownerFence: journalItemExecutionFence(state, opener.itemId) ?? submission.fence,
        clientMessageId: submission.clientMessageId
      }
      this.openers.set(key, target)
      this.anchors.set(key, key)
      this.active.set(key, target)
    }
    this.refresh(state, key)
  }

  refresh(state: JournalReducerState, anchorId: string): void {
    const fact = state.items.get(anchorId)?.executionInterruption
    const id = fact && (fact.target.executionId ?? fact.owner.itemId)
    const life = id === undefined ? undefined : this.turns.get(id)
    if (!fact || id === undefined || !(life ? life.active : this.openers.has(id))) {
      if (id !== undefined) {
        this.requests.delete(id)
      }
      return
    }
    const prior = this.requests.get(id)
    this.requests.set(id, {
      sequence: fact.sequence,
      event: fact.first.event,
      target: fact.target,
      observedAt: fact.observedAt,
      ...(prior?.settle ? { settle: prior.settle } : {})
    })
  }
  rememberAlias(alias: string, itemId: string): void {
    let entries = this.aliases.get(itemId)
    if (!entries) {
      entries = []
      this.aliases.set(itemId, entries)
    }
    if (!entries.includes(alias)) {
      entries.push(alias)
    }
  }
  retireSubmission(state: JournalReducerState, clientMessageId: string): void {
    const key = agentJournalSubmissionKey(clientMessageId)
    state.submissions.delete(clientMessageId)
    state.receipts.delete(clientMessageId)
    for (const alias of this.aliases.get(key) ?? []) {
      state.aliases.delete(alias)
    }
    this.aliases.delete(key)
  }
  remove(turnId?: string, clientMessageId?: string, exact?: JournalCancellationTarget): void {
    const target = exact ?? (turnId === undefined ? undefined : this.turn(turnId))
    const id =
      target?.executionId ??
      (clientMessageId === undefined ? undefined : agentJournalSubmissionKey(clientMessageId))
    if (id === undefined) {
      return
    }
    this.requests.delete(id)
    this.active.delete(id)
    this.turns.delete(id)
    this.openers.delete(id)
    if (turnId !== undefined && this.heads.get(turnId) === id) {
      this.heads.delete(turnId)
    }
  }
  capture(ownerFence: number, turnId?: string): JournalCancellationTarget[] {
    if (turnId !== undefined) {
      const target = this.turn(turnId)
      return target ? [target] : []
    }
    return [...this.active.values()].filter((target) => target.ownerFence === ownerFence)
  }
}
