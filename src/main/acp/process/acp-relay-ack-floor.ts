import type { ProviderRelayAckFloor } from '../../provider-relay/relayed-provider-output'
import { acpCutKeyNames, CONTINUED_ID, type AcpRelayItem as Item } from './acp-relay-cut-key-names'
import { jsonRpcAnswerId } from '../../provider-relay/relayed-json-rpc-lines'
import {
  ACP_MESSAGE_BOUNDARIES,
  ACP_MESSAGE_CHUNKS,
  ACP_MESSAGE_ENDS,
  acpSessionUpdateFields
} from './acp-session-update-fields'

const MAX_OPEN_ITEMS = 256

/** A message an earlier attach's cut split, as its continuation names it. */
export type AcpInheritedCut = { session: string; id: string; child: boolean; resumes: boolean }

function moveSession(
  from: Map<string, Item>,
  to: Map<string, Item>,
  session?: string,
  except?: string
): void {
  for (const [id, item] of from) {
    if (item.session === session && id !== except && (to.has(id) || to.size < MAX_OPEN_ITEMS)) {
      from.delete(id)
      to.set(id, item)
    }
  }
}

/** Messages are put back at their old start when one resumes, so they're read for the least. */
const earliest = (open: Map<string, { seq: number }>): number | null =>
  open.size === 0 ? null : Math.min(...[...open.values()].map((item) => item.seq))
/** A session's messages held whole at once; another one past these supersedes the oldest. */
const HELD_PER_SESSION = 16
const first = (open: Map<string, { seq: number }>): number | null =>
  open.values().next().value?.seq ?? null

/**
 * One attach's floor. Acks stay below the start of each open call (until its final status or its
 * prompt's end) and each open message (until another message, a user chunk or a child status of
 * its session, or its
 * prompt's end), so a reattach replays each from its first line and rewrites its row whole.
 * Messages without ids are numbered within their prompt's turn, so while a prompt runs, until the
 * agent shows it gives ids (and in any turn with one without), the turn's first line holds too:
 * the replay numbers them again as the live run did. Only session updates are read past their
 * envelope.
 */
export class AcpRelayAckFloor implements ProviderRelayAckFloor {
  /** Insertion order is seq order, so the first entry is the earliest. */
  private readonly calls = new Map<string, { seq: number }>()
  private readonly messages = new Map<string, Item & { seq: number }>()
  private firstSeq: number | null = null
  /** The running prompt's first line; null between prompts and before its first line. */
  private turnStart: number | null = null
  private turnPending: boolean
  private numbered = false
  private givesIds = false
  /** Messages a forced ack released mid-stream: every ack while one streams is a cut, so a
   *  reattach moves the tail it replays to a continuation row instead of over the saved text. */
  private readonly cutMessages = new Map<string, Item>()
  /** Cut messages a call or plan followed: a replay past it starts whole until one resumes. */
  private readonly pausedCuts = new Map<string, Item>()
  /** Sessions whose latest update was a call or plan. */
  private readonly pastBoundary = new Set<string | undefined>()
  /** Messages another one followed, by their start: one resuming is held from that start again if
   *  no ack passed it, else it is cut (its start may be acked). */
  private readonly superseded = new Map<string, Item & { seq: number }>()
  /** How far acks may have reached: past this, a line may not replay again. */
  private ackable = 0
  /** Ended messages with lines past `ackable`: a replay from there shows them without their
   *  start, so they're named until acks pass their last line. */
  private readonly ended = new Map<string, Item>()
  /** The output names on every ack what a replay would split, so saved lines aren't shown twice. */
  readonly namesEveryAck = true
  /** A reattach answers the open from kept lines, never waiting on the agent. */
  readonly keepsHeldReplay = true
  /** Messages of agent-started turns the app ended: a late chunk of one is dropped, as live. */
  private endedByTurn = new Set<string>()
  private wakeAck: (() => void) | null = null
  /** The running prompt's answer, where it was read: its turn ends only after later lines were. */
  private answeredAt: number | null = null
  /** The running prompt's request id, whose answer line ends its turn (ids never repeat). */
  promptId: number | null = null
  /** An earlier cut named fewer than it split: this attach's cuts say so too. */
  private carriedOverflow = false
  /** Child sessions open at that cut: their unnamed messages may resume past the prompt's end. */
  private readonly overflowChildren = new Set<string>()
  /** Per session, the message its latest chunk named: only a new one ends the others. */
  private readonly current = new Map<string | undefined, string>()

  /** `running`: a prompt runs across this attach (a dropped stream), so its turn holds from here. */
  constructor(running: boolean) {
    this.turnPending = running
  }

  observe(seq: number, line: string): void {
    this.firstSeq ??= seq
    if (this.turnPending) {
      this.turnPending = false
      this.turnStart = seq
    }
    const update = acpSessionUpdateFields(line)
    const kind = update?.sessionUpdate
    if (!update || !kind) {
      // The running prompt's own answer, a result or an error.
      const prompt = this.promptId
      this.answeredAt =
        prompt !== null && !update && jsonRpcAnswerId(line) === prompt ? seq : this.answeredAt
      return
    }
    const session = update.sessionId
    if (ACP_MESSAGE_ENDS.has(kind)) {
      this.closeMessages(session)
      if (update.child && session !== undefined) {
        this.overflowChildren.delete(session)
      }
    }
    if (ACP_MESSAGE_BOUNDARIES.has(kind)) {
      this.pastBoundary.add(session)
      moveSession(this.cutMessages, this.pausedCuts, session)
    }
    if (ACP_MESSAGE_CHUNKS.has(kind)) {
      this.pastBoundary.delete(session)
      const id = update.messageId
      if (id === undefined) {
        this.numbered = true
      } else {
        this.givesIds = true
        if (this.endedByTurn.has(id)) {
          return
        }
        // Another message started: earlier ones of its session pause. One resuming its id after a
        // call or another message is held whole again, or cut once acks passed its start.
        if (this.current.get(session) !== id) {
          this.closeMessages(session, id)
          if (this.current.size < MAX_OPEN_ITEMS || this.current.has(session)) {
            this.current.set(session, id)
          }
        }
        const paused = this.pausedCuts.get(id)
        if (paused) {
          this.pausedCuts.delete(id)
          this.cutMessages.set(id, paused)
        }
        const earlier = this.superseded.get(id)
        if (earlier) {
          this.superseded.delete(id)
          const { seq: start, ...item } = earlier
          if (start <= this.ackable) {
            this.cutMessages.set(id, item)
          } else {
            this.open(this.messages, id, earlier)
          }
        }
        // A cut message is never held: a replay can't rewrite it whole, and holding it from here
        // would replay text already saved onto its continuation row.
        if (!this.cutMessages.has(id)) {
          this.open(this.messages, id, { seq, session, child: update.child === true })
        }
        const streaming = this.messages.get(id) ?? this.cutMessages.get(id)
        if (streaming) {
          streaming.last = seq
        }
      }
    }
    if (kind === 'tool_call' && update.toolCallId) {
      this.open(this.calls, update.toolCallId, { seq })
    }
  }

  floor(through?: number): number | null {
    const turn = this.numbered || !this.givesIds ? this.turnStart : null
    const held = [first(this.calls), earliest(this.messages), turn].filter(
      (seq): seq is number => seq !== null
    )
    const floor = held.length > 0 ? Math.min(...held) : null
    this.ackable = Math.max(
      this.ackable,
      floor === null ? (through ?? 0) : Math.min(floor - 1, through ?? floor - 1)
    )
    return floor
  }

  /** `adopted`: an earlier app's prompt, whose turn began at this attach's first replayed line;
   *  the calls and messages already read from that replay stay open. */
  startTurn(adopted: boolean): void {
    if (!adopted) {
      // The agent turn a prompt follows stays the latest closed one until the prompt's own end.
      const ended = this.endedByTurn
      this.endTurn()
      this.endedByTurn = ended
    }
    this.turnStart = adopted ? this.firstSeq : null
    this.turnPending = this.turnStart === null
  }

  /** A forced ack released through `seq`: what started there is acked already, so later items
   *  (a new call, a new message) hold the floor on their own. */
  released(seq: number): void {
    this.ackable = Math.max(this.ackable, seq)
    for (const [id, { seq: start, ...item }] of this.messages) {
      const cuts = this.pastBoundary.has(item.session) ? this.pausedCuts : this.cutMessages
      if (start <= seq && cuts.size < MAX_OPEN_ITEMS) {
        cuts.set(id, item)
      }
    }
    for (const open of [this.calls, this.messages]) {
      for (const [key, item] of open) {
        if (item.seq <= seq) {
          open.delete(key)
        }
      }
    }
    if (this.turnStart !== null && this.turnStart <= seq) {
      this.turnStart = null
    }
  }

  /** Until each cut message ends, even past a call (it may resume under its id), acks are cuts. */
  tookCut(): boolean {
    return this.cutMessages.size > 0 || this.pausedCuts.size > 0
  }

  /** The messages a cut splits, keyed as the continuation keys them from the agent's own lines (a
   *  continuation's re-keyed id names its original): the cut ones and, for a release through
   *  `through`, those open there. A reattach moves exactly these. */
  cutKeys(through?: number): string[] {
    const named: [string, Item][] = [...this.cutMessages, ...this.pausedCuts]
    for (const [id, item] of this.messages) {
      // A held continuation too: unnamed, its replay would land on the original's row.
      if ((through !== undefined && item.seq <= through) || CONTINUED_ID.test(id)) {
        named.push([id, item])
      }
    }
    // Superseded ones whose start an ack may pass resume without it; ended ones still replay.
    for (const [id, item] of this.superseded) {
      if (item.seq <= this.ackable) {
        named.push([id, item])
      }
    }
    for (const [id, item] of this.ended) {
      if ((item.last ?? 0) > this.ackable) {
        named.push([id, item])
      } else {
        this.ended.delete(id)
      }
    }
    return acpCutKeyNames(named, HELD_PER_SESSION, this.carriedOverflow)
  }

  /** What an earlier attach's cut split and may still resume: cut here too, so a later cut of
   *  this attach names it again instead of dropping it from the daemon's record. */
  inheritCuts(
    cuts: readonly AcpInheritedCut[],
    overflow: boolean,
    savedThrough: number,
    openChildren: readonly string[] = []
  ): void {
    for (const { session, id, child, resumes } of cuts) {
      const known = this.messages.has(id) || this.cutMessages.has(id) || this.pausedCuts.has(id)
      if (known) {
        continue
      }
      // One that can't resume is named while its saved lines may still replay.
      if (resumes && this.pausedCuts.size < MAX_OPEN_ITEMS) {
        this.pausedCuts.set(id, { session, child, last: savedThrough })
      } else if (!resumes) {
        this.retire(id, { session, child, last: savedThrough })
      }
    }
    this.carriedOverflow ||= overflow
    for (const child of overflow ? openChildren : []) {
      if (this.overflowChildren.size < MAX_OPEN_ITEMS) {
        this.overflowChildren.add(child)
      }
    }
  }

  private retire(id: string, item: Item): void {
    if ((item.last ?? 0) > this.ackable) {
      if (this.ended.size >= MAX_OPEN_ITEMS) {
        this.ended.delete(this.ended.keys().next().value ?? '')
      }
      this.ended.set(id, item)
    }
  }

  wake(ack: () => void): void {
    this.wakeAck = ack
  }

  /** The app ended an agent-started turn: its messages stream no more, and acks may pass them.
   *  Like the app, which drops a late chunk only of its latest closed turn, only its ids are kept. */
  endAgentTurn(): void {
    const ended = new Set<string>()
    for (const open of [this.messages, this.cutMessages, this.pausedCuts, this.superseded]) {
      for (const [id, item] of open) {
        if (!item.child && ended.size < MAX_OPEN_ITEMS) {
          ended.add(id)
        }
      }
    }
    this.endTurn()
    this.endedByTurn = ended
    this.wakeAck?.()
  }

  /** The call reported its final status. */
  endCall(toolCallId: string): void {
    this.calls.delete(toolCallId)
  }

  /** Answered or failed: its calls Orca backgrounds are restated from their saved rows instead.
   *  `answered`: ended by an answer the app reads after it (a promise's turn), so what the agent
   *  began after the last answer line belongs to its next turn and stays. */
  endTurn(answered = false): void {
    const after = answered ? this.answeredAt : null
    const next = (seq?: number) => after !== null && seq !== undefined && seq > after
    for (const [id, call] of this.calls) {
      if (!next(call.seq)) {
        this.calls.delete(id)
      }
    }
    // A subagent's message goes on past its parent's prompt, until its own next message or status.
    for (const open of [this.messages, this.cutMessages, this.pausedCuts, this.superseded]) {
      for (const [id, item] of open) {
        if (
          !item.child &&
          !next('seq' in item && typeof item.seq === 'number' ? item.seq : item.last)
        ) {
          open.delete(id)
          this.retire(id, item)
        }
      }
    }
    this.pastBoundary.clear()
    this.current.clear()
    this.endedByTurn = new Set()
    // An earlier cut's unnamed messages can resume no more once its prompt ended, but a child's can.
    const cuts = [...this.cutMessages.values(), ...this.pausedCuts.values()]
    this.carriedOverflow &&= this.overflowChildren.size > 0 || cuts.some((item) => item.child)
    this.turnStart = null
    this.turnPending = false
    this.numbered = false
    this.answeredAt = null
  }

  /** Ends a session's messages, all but `except`. */
  private closeMessages(session: string | undefined, except?: string): void {
    if (except !== undefined) {
      // A message resumes its id after another's within a step (OpenCode's text between its
      // reasoning blocks): a cut one pauses, and a session's latest few stay held from their
      // start. Older ones are superseded: one that resumes after all is cut if acks passed it.
      moveSession(this.cutMessages, this.pausedCuts, session, except)
      const held = [...this.messages].filter(
        ([id, item]) => id !== except && item.session === session
      )
      held.sort(([, a], [, b]) => (a.last ?? a.seq) - (b.last ?? b.seq))
      for (const [id, item] of held.slice(0, Math.max(0, held.length - HELD_PER_SESSION + 1))) {
        this.messages.delete(id)
        if (this.superseded.size >= MAX_OPEN_ITEMS) {
          this.superseded.delete(this.superseded.keys().next().value ?? '')
        }
        this.superseded.set(id, item)
      }
      return
    }
    this.current.delete(session)
    for (const open of [this.messages, this.cutMessages, this.pausedCuts, this.superseded]) {
      for (const [id, item] of open) {
        if (item.session === session) {
          open.delete(id)
          this.retire(id, item)
        }
      }
    }
  }

  private open<T>(map: Map<string, T>, key: string, entry: T): void {
    if (!map.has(key) && map.size < MAX_OPEN_ITEMS) {
      map.set(key, entry)
    }
  }
}
