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

/** Canonical retained ownership and a derived unresolved view; receipts never define execution life. */
export class JournalCancellationTargets {
  private turns: Record<string, ExecutionTurn> = {}
  private linked: Record<string, string> = {}
  private anchors: Record<string, string> = {}
  private aliases: Record<string, string[]> = {}
  private rawLinks: Record<string, string> = {}
  private openers: Record<string, JournalCancellationTarget> = {}
  private active: Record<string, JournalCancellationTarget> = {}
  private requests: Record<string, PendingCancellation> = {}
  private retained: Record<string, JournalCancellationTarget> = {}

  turn(turnId: string): JournalCancellationTarget | undefined {
    return this.turns[`turn:${turnId}`]?.target
  }
  turnItem(turnId: string): string | undefined {
    return this.turns[`turn:${turnId}`]?.itemId
  }
  openerTurn(clientMessageId: string): string | undefined {
    return this.linked[`send:${clientMessageId}`]
  }
  restoreOwner(item: JournalOwnedItem): void {
    const target = item.executionInterruption?.target
    if (!target) {
      return
    }
    if (target.turnId !== undefined) {
      this.retained[`turn:${target.turnId}`] = target
    } else if (target.clientMessageId !== undefined) {
      const key = `send:${target.clientMessageId}`
      if (this.linked[key] === undefined) {
        this.openers[key] = target
        this.active[key] = target
      }
    }
  }
  anchor(target: JournalCancellationTarget): string | undefined {
    if (target.turnId !== undefined && this.anchors[`turn:${target.turnId}`]) {
      return this.anchors[`turn:${target.turnId}`]
    }
    return target.clientMessageId !== undefined
      ? agentJournalSubmissionKey(target.clientMessageId)
      : target.turnId === undefined
        ? undefined
        : this.turnItem(target.turnId)
  }
  history(state: JournalReducerState, turnId: string) {
    const target = this.turn(turnId)
    const anchor = target && this.anchor(target)
    const fact = anchor === undefined ? undefined : state.items.get(anchor)?.executionInterruption
    return fact?.target.ownerFence === target?.ownerFence && fact?.target.turnId === turnId
      ? fact
      : undefined
  }
  pending(): PendingCancellation[] {
    return Object.values(this.requests)
  }
  unresolved(): JournalCancellationTarget[] {
    return Object.values(this.active)
  }

  observeTurn(state: JournalReducerState, item: JournalOwnedItem): void {
    this.restoreOwner(item)
    const turn = readAgentJournalTurn(item.body)
    if (!turn) {
      this.refresh(state, item.itemId)
      return
    }
    const ownerFence = journalItemExecutionFence(state, item.itemId) ?? 0
    const retained = this.retained[`turn:${turn.turnId}`]
    const prior = this.turn(turn.turnId)
    const previousAnchor = prior && this.anchor(prior)
    if (prior && prior.ownerFence !== ownerFence && previousAnchor !== undefined) {
      delete this.requests[previousAnchor]
    }
    const clientMessageId =
      (retained?.ownerFence === ownerFence ? retained.clientMessageId : undefined) ??
      (prior?.ownerFence === ownerFence ? prior.clientMessageId : undefined) ??
      turnOpeningClientId(state, turn.userItemId)
    const target = {
      turnId: turn.turnId,
      ownerFence,
      ...(clientMessageId !== undefined ? { clientMessageId } : {})
    }
    if (turn.userItemId !== undefined) {
      this.rawLinks[turn.userItemId] = turn.turnId
    }
    const openerKey =
      clientMessageId === undefined ? undefined : agentJournalSubmissionKey(clientMessageId)
    this.anchors[`turn:${turn.turnId}`] =
      openerKey !== undefined && state.items.has(openerKey) ? openerKey : item.itemId
    const active = turn.state === 'running' || turn.state === 'unverifiable'
    this.turns[`turn:${turn.turnId}`] = { itemId: item.itemId, target, active }
    if (clientMessageId !== undefined) {
      this.linked[`send:${clientMessageId}`] = turn.turnId
      delete this.openers[`send:${clientMessageId}`]
      delete this.active[`send:${clientMessageId}`]
    }
    if (active && !state.removedTurnIds.has(turn.turnId)) {
      this.active[`turn:${turn.turnId}`] = target
    } else {
      delete this.active[`turn:${turn.turnId}`]
    }
    const anchorId = this.anchor(target)
    const anchor = anchorId === undefined ? undefined : state.items.get(anchorId)
    const fact = anchor?.executionInterruption ?? item.executionInterruption
    if (fact && anchor && anchor.itemId !== item.itemId && item.executionInterruption) {
      const { executionInterruption: _moved, ...provider } = item
      state.items.set(item.itemId, provider)
      state.items.set(anchor.itemId, {
        ...anchor,
        executionInterruption: { ...fact, target: { ...target } }
      })
      delete this.requests[item.itemId]
    }
    if (
      fact &&
      anchor &&
      fact.target.ownerFence === target.ownerFence &&
      fact.target.turnId !== turn.turnId
    ) {
      state.items.set(anchor.itemId, {
        ...anchor,
        executionInterruption: { ...fact, target: { ...fact.target, turnId: turn.turnId } }
      })
    }
    if (anchorId !== undefined) {
      this.refresh(state, anchorId)
    }
  }

  observeSubmission(
    state: JournalReducerState,
    submission: AgentJournalSubmission,
    item?: JournalOwnedItem
  ): void {
    const id = submission.clientMessageId
    const rawTurn =
      submission.providerItemId === null ? undefined : this.rawLinks[submission.providerItemId]
    const rawItemId = rawTurn === undefined ? undefined : this.turnItem(rawTurn)
    const rawItem = rawItemId === undefined ? undefined : state.items.get(rawItemId)
    if (rawItem) {
      this.observeTurn(state, rawItem)
    }
    const key = `send:${id}`
    const opener = item ?? state.items.get(agentJournalSubmissionKey(id))
    if (
      this.linked[key] !== undefined ||
      (submission.dispatchState === 'rejected' &&
        agentJournalSubmissionProvenUnwritten(submission)) ||
      opener?.turnScope?.kind === 'turn'
    ) {
      delete this.openers[key]
      delete this.active[key]
    } else if (opener && (submission.handedOverAt !== undefined || !submission.handoverRecorded)) {
      const target = {
        ownerFence: journalItemExecutionFence(state, opener.itemId) ?? submission.fence,
        clientMessageId: id
      }
      this.openers[key] = target
      this.active[key] = target
    }
    this.refresh(state, agentJournalSubmissionKey(id))
  }

  refresh(state: JournalReducerState, anchorId: string): void {
    const fact = state.items.get(anchorId)?.executionInterruption
    const target = fact?.target
    const life = target?.turnId === undefined ? undefined : this.turns[`turn:${target.turnId}`]
    const unresolved =
      target &&
      (life
        ? life.active &&
          life.target.ownerFence === target.ownerFence &&
          !state.removedTurnIds.has(life.target.turnId!)
        : (target.turnId === undefined || !state.removedTurnIds.has(target.turnId)) &&
          target.clientMessageId !== undefined &&
          this.openers[`send:${target.clientMessageId}`] !== undefined)
    if (!fact || !unresolved) {
      delete this.requests[anchorId]
      return
    }
    const prior = this.requests[anchorId]
    this.requests[anchorId] = {
      sequence: fact.sequence,
      event: fact.first.event,
      target: fact.target,
      observedAt: fact.observedAt,
      ...(prior?.settle ? { settle: prior.settle } : {})
    }
  }

  rememberAlias(alias: string, itemId: string): void {
    const entries = (this.aliases[itemId] ??= [])
    if (!entries.includes(alias)) {
      entries.push(alias)
    }
  }
  retireSubmission(state: JournalReducerState, clientMessageId: string): void {
    const key = agentJournalSubmissionKey(clientMessageId)
    state.submissions.delete(clientMessageId)
    state.receipts.delete(clientMessageId)
    for (const alias of this.aliases[key] ?? []) {
      state.aliases.delete(alias)
    }
    delete this.aliases[key]
  }

  remove(turnId?: string, clientMessageId?: string): void {
    const target = turnId === undefined ? undefined : this.turn(turnId)
    const anchorId = target
      ? this.anchor(target)
      : clientMessageId === undefined
        ? undefined
        : agentJournalSubmissionKey(clientMessageId)
    if (anchorId !== undefined) {
      delete this.requests[anchorId]
    }
    if (turnId !== undefined) {
      delete this.turns[`turn:${turnId}`]
      delete this.active[`turn:${turnId}`]
    }
    if (clientMessageId !== undefined) {
      delete this.openers[`send:${clientMessageId}`]
      delete this.active[`send:${clientMessageId}`]
    }
  }
  capture(ownerFence: number, turnId?: string): JournalCancellationTarget[] {
    if (turnId !== undefined) {
      const target = this.turn(turnId)
      return target ? [target] : []
    }
    return Object.values(this.active).filter((target) => target.ownerFence === ownerFence)
  }
}
export function restoreJournalCancellationTargets(state: JournalReducerState): void {
  const targets = new JournalCancellationTargets()
  state.derivedTurnScope.cancellations = targets
  for (const [alias, itemId] of state.aliases) {
    targets.rememberAlias(alias, itemId)
  }
  for (const item of state.items.values()) {
    targets.restoreOwner(item)
  }
  for (const item of state.items.values()) {
    targets.observeTurn(state, item)
  }
  for (const submission of state.submissions.values()) {
    targets.observeSubmission(state, submission)
  }
}
