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

type ClaudeRunInput = ClaudeOfferedInput & {
  /** Its own receipt, echo, result correlation, or the run's first execution proved Claude ran it here. */
  participated: boolean
  receipt?: 'queued' | 'started' | 'ended'
  /** The uuid Claude gave its echo; results may name the input by it. */
  echoUuid?: string
}

/** Orca inputs behind the open run, and those a finished run never consumed, owed to a later cycle. */
export class ClaudeInputRuns {
  private members: ClaudeRunInput[] = []
  private successors: ClaudeRunInput[] = []
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
    return this.members.length > 0
  }

  get anchor(): ClaudeOfferedInput | null {
    return this.members[0] ?? null
  }

  /** Root work outside a run belongs to an owed input Claude has not reported as merely queued. */
  get successor(): ClaudeOfferedInput | null {
    return (
      this.successors.find((input) => input.receipt === 'started') ??
      this.successors.find((input) => input.receipt !== 'queued') ??
      null
    )
  }

  /** Claude runs owed inputs in order, so the oldest anchors the next run. */
  get oldestOwed(): ClaudeOfferedInput | null {
    return this.successors[0] ?? null
  }

  owns(clientMessageId: string): boolean {
    return this.members.some((input) => input.clientMessageId === clientMessageId)
  }

  /** True when the offer needs a new run; a live run gains it as a provisional member, a command owes it. */
  offer(input: ClaudeOfferedInput, runOpen: boolean): boolean {
    const offered = { ...input, participated: false }
    if (runOpen && this.joinable) {
      this.members.push(offered)
    } else {
      this.successors.push(offered)
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
      this.members = []
      return
    }
    const anchor = this.successors.find((input) => input.clientMessageId === anchorClientMessageId)
    this.members = anchor
      ? [anchor, ...this.successors.filter((i) => i !== anchor)]
      : this.successors
    this.successors = []
    if (anchor && (!offered || anchor.receipt === 'started')) {
      this.participate(anchor)
    }
  }

  /** Inputs the ended run never ran stay owed; delivery waiters keep their own recovery. */
  end(): void {
    this.successors.push(
      ...this.members.filter((input) => !input.participated && input.receipt !== 'ended')
    )
    this.members = []
    this.joinable = false
    this.awaiting = false
    this.predecessorOpen = false
  }

  /** The child is gone and can run nothing it was given. */
  reset(): void {
    this.end()
    this.successors = []
    this.cycleOpen = false
  }

  /** Removes only the input Claude proved it never ran. */
  withdraw(clientMessageId: string): 'kept' | 'reanchor' | 'retract' {
    const matches = (input: ClaudeRunInput) => input.clientMessageId === clientMessageId
    this.successors = this.successors.filter((input) => !matches(input))
    const index = this.members.findIndex(matches)
    if (index === -1) {
      return 'kept'
    }
    this.members.splice(index, 1)
    if (this.members.length === 0) {
      return this.worked ? 'kept' : 'retract'
    }
    return index === 0 ? 'reanchor' : 'kept'
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
        this.successors.push(...this.members.filter((input) => !input.participated))
        this.members = this.members.filter((input) => input.participated)
      }
      this.predecessorOpen = false
      this.startCycle()
    } else if (type === 'system' && message.subtype === 'session_state_changed') {
      if (claudeText(message.state) === 'running') {
        this.startCycle()
      }
    } else if (type === 'user') {
      const input = this.members.find(
        (member) =>
          member.clientMessageId === clientMessageId ||
          member.sentUuid === claudeText(message.uuid) ||
          member.sentUuid === claudeText(message.user_message_uuid)
      )
      if (input) {
        const echo = claudeText(message.uuid)
        if (echo) {
          input.echoUuid = echo
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

  /** Correlated results end the run they name; an unnamed one only an executing run. */
  resultEndsRun(message: Record<string, unknown>): boolean {
    const names = new Set(claudeResultUserMessageUuids(message))
    const named = claudeText(message.user_message_uuid)
    if (named) {
      names.add(named)
    }
    const hits = this.members.filter(
      (input) => names.has(input.sentUuid) || (input.echoUuid && names.has(input.echoUuid))
    )
    hits.forEach((input) => this.participate(input))
    const ends = !this.tracked || (names.size > 0 ? hits.length > 0 : !this.awaiting)
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

  private observeReceipt(commandUuid: string | null, state: string | null): void {
    const input = [...this.members, ...this.successors].find((i) => i.sentUuid === commandUuid)
    if (!input) {
      return
    }
    if (state === 'started') {
      input.receipt = 'started'
      // Claude runs one command at a time, so its start also ends any earlier cycle.
      this.predecessorOpen = false
      if (this.members.includes(input)) {
        this.participate(input)
      }
    } else if (state === 'queued') {
      input.receipt = input.receipt === 'started' ? 'started' : 'queued'
    } else if (state !== null) {
      input.receipt = 'ended'
      this.successors = this.successors.filter((owed) => owed !== input)
    }
  }

  private participate(input: ClaudeRunInput): void {
    input.participated = true
    this.awaiting = false
    this.predecessorOpen = false
    this.cycleOpen = true
  }

  /** Ordered cycle evidence is this run's first execution unless the earlier cycle still runs. */
  private startCycle(): void {
    this.cycleOpen = true
    if (this.awaiting && !this.predecessorOpen) {
      this.awaiting = false
      const anchor = this.members[0]
      if (anchor) {
        anchor.participated = true
      }
    }
  }
}
