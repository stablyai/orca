// Handoff, delivery proof, execution and the provider cycle end are separate facts with separate lifetimes:
// a run owns the inputs handed over for it, delivery waiters only prove which messages reached Claude.

import { claudeText } from './structured/journal/claude-structured-item-translation'
import { claudeResultUserMessageUuids } from './claude-replay-turn-resolution'

export type ClaudeOfferedInput = {
  sessionId: string
  sentUuid: string
  clientMessageId: string
  requestedAt?: number
}

type ClaudeRunInput = {
  readonly offered: ClaudeOfferedInput
  receipt?: 'queued' | 'started' | 'ended'
  /** The uuid Claude gave its echo; results may name the input by it. */
  echoUuid?: string
}

/** Orca inputs behind the open run, and those a finished run never consumed, owed to a later cycle.
 * Each input is reachable by every identity Claude names it with, so attribution never scans the run. */
export class ClaudeInputRuns {
  private readonly byUuid = new Map<string, ClaudeRunInput>()
  private readonly bySubmission = new Map<string, ClaudeRunInput>()
  private members = new Set<ClaudeRunInput>()
  private owed = new Set<ClaudeRunInput>()
  /** Members not yet proven to have run here (by their own receipt, echo, named result, or the run's
   * first execution); only these move at a cycle boundary or run end. */
  private readonly provisional = new Set<ClaudeRunInput>()
  private joinable = false
  /** A provider cycle began and has not reached its result or idle. */
  private cycleOpen = false
  /** The cycle running when this run was offered is still live; its frames are not this run's. */
  private predecessorOpen = false
  /** Offered, with no execution evidence of its own yet. */
  private awaiting = false
  /** Root work landed in this run, so retracting its last input cannot erase it. */
  private worked = false

  get tracked(): boolean {
    return this.members.size > 0
  }

  get anchor(): ClaudeOfferedInput | null {
    return first(this.members)?.offered ?? null
  }

  /** Root work outside a run belongs to an owed input Claude has not reported as merely queued. */
  get successor(): ClaudeOfferedInput | null {
    let unreported: ClaudeRunInput | undefined
    for (const input of this.owed) {
      if (input.receipt === 'started') {
        return input.offered
      }
      unreported ??= input.receipt === 'queued' ? undefined : input
    }
    return unreported?.offered ?? null
  }

  /** Claude runs owed inputs in order, so the oldest anchors the next run. */
  get oldestOwed(): ClaudeOfferedInput | null {
    return first(this.owed)?.offered ?? null
  }

  owns(clientMessageId: string): boolean {
    const input = this.bySubmission.get(clientMessageId)
    return input !== undefined && this.members.has(input)
  }

  /** True when the offer needs a new run; a live run gains it as a provisional member, a command owes it. */
  offer(offered: ClaudeOfferedInput, runOpen: boolean): boolean {
    const input: ClaudeRunInput = { offered }
    this.byUuid.set(offered.sentUuid, input)
    this.bySubmission.set(offered.clientMessageId, input)
    if (runOpen && this.joinable) {
      this.members.add(input)
      this.provisional.add(input)
    } else {
      this.owed.add(input)
    }
    return !runOpen
  }

  /** Owed inputs join every run that can fold them; commands run alone. */
  begin(anchorClientMessageId: string | null, offered: boolean, joinable: boolean): void {
    this.joinable = joinable
    this.worked = false
    this.awaiting = offered
    this.predecessorOpen = offered && this.cycleOpen
    if (!joinable) {
      return
    }
    const owedAnchor = anchorClientMessageId && this.bySubmission.get(anchorClientMessageId)
    const anchor = owedAnchor && this.owed.has(owedAnchor) ? owedAnchor : undefined
    this.members = new Set(anchor ? [anchor, ...this.owed] : this.owed)
    this.owed = new Set()
    for (const input of this.members) {
      this.provisional.add(input)
    }
    if (anchor && (!offered || anchor.receipt === 'started')) {
      this.participate(anchor)
    }
  }

  /** Inputs the ended run consumed or Claude ended leave for good; only unconsumed offers stay owed. */
  end(): void {
    for (const input of this.members) {
      if (this.provisional.has(input) && input.receipt !== 'ended') {
        this.owed.add(input)
      } else {
        this.retire(input)
      }
    }
    this.members.clear()
    this.provisional.clear()
    this.joinable = false
    this.awaiting = false
    this.predecessorOpen = false
  }

  /** The child is gone and can run nothing it was given. */
  reset(): void {
    this.end()
    this.owed.clear()
    this.byUuid.clear()
    this.bySubmission.clear()
    this.cycleOpen = false
  }

  /** Removes only the input Claude proved it never ran. */
  withdraw(clientMessageId: string): 'kept' | 'reanchor' | 'retract' {
    const input = this.bySubmission.get(clientMessageId)
    if (!input || !this.members.has(input)) {
      if (input) {
        this.retire(input)
      }
      return 'kept'
    }
    const anchored = first(this.members) === input
    this.retire(input)
    if (this.members.size === 0) {
      return this.worked ? 'kept' : 'retract'
    }
    return anchored ? 'reanchor' : 'kept'
  }

  /** Attribute a root frame to this run's inputs and cycle before any of its effects apply. */
  observe(
    message: Record<string, unknown>,
    clientMessageId: string | undefined,
    responded: boolean
  ) {
    const type = message.type
    if (type === 'command_lifecycle') {
      this.observeReceipt(claudeText(message.command_uuid), claudeText(message.state))
    } else if (type === 'system' && message.subtype === 'init') {
      // A new cycle after this run already answered is the missing-result boundary.
      if (responded) {
        for (const input of this.provisional) {
          this.members.delete(input)
          this.owed.add(input)
        }
        this.provisional.clear()
      }
      this.predecessorOpen = false
      this.startCycle()
    } else if (type === 'system' && message.subtype === 'session_state_changed') {
      if (claudeText(message.state) === 'running') {
        this.startCycle()
      }
    } else if (type === 'user') {
      const input =
        (clientMessageId === undefined ? undefined : this.bySubmission.get(clientMessageId)) ??
        this.named(message.uuid) ??
        this.named(message.user_message_uuid)
      const echo = claudeText(message.uuid)
      if (input && this.members.has(input)) {
        if (echo) {
          input.echoUuid = echo
          this.byUuid.set(echo, input)
        }
        this.participate(input)
      }
    } else if (
      type === 'assistant' ||
      type === 'stream_event' ||
      (type === 'system' && message.subtype === 'status' && claudeText(message.status))
    ) {
      this.worked ||= this.joinable
      this.startCycle()
    }
  }

  /** A named result is each named input's own endpoint wherever it is; it ends this run only if it names a member.
   * An unnamed result ends only an executing run. */
  resultEndsRun(message: Record<string, unknown>): boolean {
    const names = claudeResultUserMessageUuids(message)
    const singular = claudeText(message.user_message_uuid)
    if (singular) {
      names.push(singular)
    }
    let namesMember = false
    for (const name of names) {
      const input = this.byUuid.get(name)
      if (input && this.members.has(input)) {
        namesMember = true
        this.participate(input)
      } else if (input) {
        this.retire(input)
      }
    }
    const ends = !this.tracked || (names.length > 0 ? namesMember : !this.awaiting)
    this.cycleOpen = false
    this.predecessorOpen = false
    return ends
  }

  /** Idle before this run's own execution is the previous cycle's tail. */
  endsAtIdle(): boolean {
    const ends = !this.awaiting
    this.cycleOpen = false
    this.predecessorOpen = false
    return ends
  }

  private named(uuid: unknown): ClaudeRunInput | undefined {
    const name = claudeText(uuid)
    return name === null ? undefined : this.byUuid.get(name)
  }

  private observeReceipt(commandUuid: string | null, state: string | null): void {
    const input = commandUuid === null ? undefined : this.byUuid.get(commandUuid)
    if (!input) {
      return
    }
    if (state === 'started') {
      input.receipt = 'started'
      // Claude runs one command at a time, so its start also ends any earlier cycle.
      this.predecessorOpen = false
      if (this.members.has(input)) {
        this.participate(input)
      }
    } else if (state === 'queued') {
      input.receipt = input.receipt === 'started' ? 'started' : 'queued'
    } else if (state !== null) {
      input.receipt = 'ended'
      if (!this.members.has(input)) {
        this.retire(input)
      }
    }
  }

  /** The one way an input stops being owed: every identity and collection drops it together. */
  private retire(input: ClaudeRunInput): void {
    this.byUuid.delete(input.offered.sentUuid)
    if (input.echoUuid) {
      this.byUuid.delete(input.echoUuid)
    }
    this.bySubmission.delete(input.offered.clientMessageId)
    this.members.delete(input)
    this.owed.delete(input)
    this.provisional.delete(input)
  }

  private participate(input: ClaudeRunInput): void {
    this.provisional.delete(input)
    this.awaiting = false
    this.predecessorOpen = false
    this.cycleOpen = true
  }

  /** Ordered cycle evidence is this run's first execution unless the earlier cycle still runs. */
  private startCycle(): void {
    this.cycleOpen = true
    if (this.awaiting && !this.predecessorOpen) {
      this.awaiting = false
      const anchor = first(this.members)
      if (anchor) {
        this.provisional.delete(anchor)
      }
    }
  }
}

function first<T>(items: ReadonlySet<T>): T | undefined {
  return items.values().next().value
}
