import { leadingJsonEnvelope } from '../../../shared/json-stream/json-rpc-record-prefix'
import type { ProviderRelayAckFloor } from '../../provider-relay/relayed-provider-output'

/** The methods ACP agents send session updates under: the standard one and Grok's. */
export const ACP_SESSION_UPDATE_METHODS = new Set([
  'session/update',
  'x.ai/session_notification',
  '_x.ai/session_notification',
  'x.ai/session/update',
  '_x.ai/session/update'
])

/** Those and OpenCode's child sessions' updates, which carry their own messages and calls. */
const ACP_UPDATE_METHODS = new Set([
  ...ACP_SESSION_UPDATE_METHODS,
  'opencode/session/child_update',
  '_opencode/session/child_update'
])

const ENVELOPE_SCAN_CHARS = 4096
/** A long line's fields are read from its start and end; no line is parsed here. */
const FIELD_WINDOW_CHARS = 4096
/** More open items than this can't be real; the oldest stay held, so nothing is acked past them. */
const MAX_OPEN_ITEMS = 256
export const ACP_MESSAGE_CHUNKS = new Set(['agent_message_chunk', 'agent_thought_chunk'])
/** An OpenCode child's status report, read as an update of its session. */
const CHILD_STATUS = 'orca:child_status'
/** Updates after which no message of a session continues. A message with an id goes on past calls
 *  under that id (OpenCode keeps one per step), so only another message or these end it. */
export const ACP_MESSAGE_ENDS = new Set([CHILD_STATUS, 'user_message_chunk'])
/** Updates after which a session's next message starts whole in a replay; a message with an id may
 *  still resume past one. */
export const ACP_MESSAGE_BOUNDARIES = new Set(['tool_call', 'tool_call_update', 'plan'])

export type AcpUpdateFields = {
  sessionId?: string
  sessionUpdate?: string
  messageId?: string
  toolCallId?: string
  /** An OpenCode child session's update. */
  child?: boolean
}

/** A key outside any string: an unescaped quote can't sit inside a JSON string. */
const field = (name: string): RegExp => new RegExp(`"${name}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`)
const SESSION_ID = field('sessionId')
const CHILD_SESSION_ID = field('childSessionId')
const SESSION_UPDATE = field('sessionUpdate')
const MESSAGE_ID = field('messageId')
const TOOL_CALL_ID = field('toolCallId')

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The fields the floor needs, scanned from the line's ends. A call's end is read by the
 *  connection, which parses every line anyway (`AcpRelayTurns.observeUpdate`). */
function updateFields(line: string): AcpUpdateFields {
  const windows =
    line.length <= 2 * FIELD_WINDOW_CHARS
      ? [line]
      : [line.slice(0, FIELD_WINDOW_CHARS), line.slice(-FIELD_WINDOW_CHARS)]
  const find = (pattern: RegExp): string | undefined =>
    windows.map((text) => pattern.exec(text)?.[1]).find((value) => value !== undefined)
  const sessionUpdate = find(SESSION_UPDATE)
  if (sessionUpdate === 'tool_call') {
    return {
      sessionId: find(CHILD_SESSION_ID) ?? find(SESSION_ID),
      sessionUpdate,
      toolCallId: find(TOOL_CALL_ID)
    }
  }
  return {
    sessionId: find(CHILD_SESSION_ID) ?? find(SESSION_ID),
    sessionUpdate,
    ...(sessionUpdate && ACP_MESSAGE_CHUNKS.has(sessionUpdate)
      ? { messageId: find(MESSAGE_ID) }
      : {})
  }
}

/** A session update's fields, or null for any other line; only the envelope's start is read. */
export function acpSessionUpdateFields(line: string): AcpUpdateFields | null {
  const { properties } = leadingJsonEnvelope(line.slice(0, ENVELOPE_SCAN_CHARS), {
    stopAtContainer: true,
    maxFields: 8
  })
  const method = properties.find((property) => property.key === 'method')?.value
  if (typeof method !== 'string' || !ACP_UPDATE_METHODS.has(method)) {
    return null
  }
  const fields = updateFields(line)
  return ACP_SESSION_UPDATE_METHODS.has(method)
    ? fields
    : { ...fields, child: true, sessionUpdate: fields.sessionUpdate ?? CHILD_STATUS }
}

const CHILD_ENDED = /"status"\s*:\s*"(?:completed|failed|interrupted)"/

/** The OpenCode child session a status line reports ended, if this line is one. */
export function acpChildSessionEnded(line: string): string | null {
  const fields = acpSessionUpdateFields(line)
  return fields?.sessionUpdate === CHILD_STATUS && fields.sessionId && CHILD_ENDED.test(line)
    ? fields.sessionId
    : null
}

type Item = { session?: string; child: boolean }
/** The tag a continuation puts before a moved message's id (`relay:<relay>:<seq>:`). */
const CONTINUED_ID = /^relay:[^:]*:\d+:/

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
class AcpRelayAckFloor implements ProviderRelayAckFloor {
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
      return
    }
    const session = update.sessionId
    if (ACP_MESSAGE_ENDS.has(kind)) {
      this.closeMessages(session)
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
        // Another message started: earlier ones of its session are done. One resuming its id
        // after a call is cut again.
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
        // A cut message is never held: a replay can't rewrite it whole, and holding it from here
        // would replay text already saved onto its continuation row.
        if (!this.cutMessages.has(id)) {
          this.open(this.messages, id, { seq, session, child: update.child === true })
        }
      }
    }
    if (kind === 'tool_call' && update.toolCallId) {
      this.open(this.calls, update.toolCallId, { seq })
    }
  }

  floor(): number | null {
    const turn = this.numbered || !this.givesIds ? this.turnStart : null
    const held = [first(this.calls), first(this.messages), turn].filter(
      (seq): seq is number => seq !== null
    )
    return held.length > 0 ? Math.min(...held) : null
  }

  /** `adopted`: an earlier app's prompt, whose turn began at this attach's first replayed line;
   *  the calls and messages already read from that replay stay open. */
  startTurn(adopted: boolean): void {
    if (!adopted) {
      this.endTurn()
    }
    this.turnStart = adopted ? this.firstSeq : null
    this.turnPending = this.turnStart === null
  }

  /** A forced ack released through `seq`: what started there is acked already, so later items
   *  (a new call, a new message) hold the floor on their own. */
  released(seq: number): void {
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
    const keys = new Set<string>()
    const name = (id: string, item: Item) =>
      keys.add(JSON.stringify([item.session, id.replace(CONTINUED_ID, '')]))
    this.cutMessages.forEach((item, id) => name(id, item))
    this.pausedCuts.forEach((item, id) => name(id, item))
    for (const [id, item] of this.messages) {
      if (through !== undefined && item.seq <= through) {
        name(id, item)
      }
    }
    return [...keys]
  }

  /** The call reported its final status. */
  endCall(toolCallId: string): void {
    this.calls.delete(toolCallId)
  }

  /** Answered or failed: its calls Orca backgrounds are restated from their saved rows instead. */
  endTurn(): void {
    this.calls.clear()
    // A subagent's message goes on past its parent's prompt, until its own next message or status.
    for (const open of [this.messages, this.cutMessages, this.pausedCuts]) {
      for (const [id, item] of open) {
        if (!item.child) {
          open.delete(id)
        }
      }
    }
    this.pastBoundary.clear()
    this.current.clear()
    this.turnStart = null
    this.turnPending = false
    this.numbered = false
  }

  /** Ends a session's messages, all but `except`. */
  private closeMessages(session: string | undefined, except?: string): void {
    if (except !== undefined) {
      // Another message ends none: OpenCode resumes a message's id after another's, so each stays
      // held from its start (a cut one only pauses) until a user chunk, child status or turn end.
      moveSession(this.cutMessages, this.pausedCuts, session, except)
      return
    }
    this.current.delete(session)
    for (const open of [this.messages, this.cutMessages, this.pausedCuts]) {
      for (const [id, item] of open) {
        if (id !== except && item.session === session) {
          open.delete(id)
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

/**
 * A relayed ACP agent's prompt turns, as the app sends, adopts and settles its prompts, read by
 * each attach's ack floor. A prompt's end that a newer prompt already superseded changes nothing.
 */
export class AcpRelayTurns {
  private running = false
  private serial = 0
  private current: AcpRelayAckFloor | null = null

  /** A fresh floor for each attach, holding a prompt that runs across it. */
  readonly ackFloor = (): ProviderRelayAckFloor => {
    this.current = new AcpRelayAckFloor(this.running)
    return this.current
  }

  /** A prompt sent by `send` (or an earlier app's one, `adopted`) runs until its answer or failure. */
  track<T>(send: () => Promise<T>, adopted = false): Promise<T> {
    const serial = ++this.serial
    this.running = true
    this.current?.startTurn(adopted)
    const end = (): void => {
      if (serial === this.serial && this.running) {
        this.running = false
        this.current?.endTurn()
      }
    }
    const answered = send()
    void answered.then(end, end)
    return answered
  }

  /** Every session update's params the connection parsed: a call's final status lets the floor
   *  past it. Acks follow the save barrier, so the parse is in before the floor is next read. */
  observeSessionUpdate(params: unknown): void {
    const update = isRecord(params) ? params.update : undefined
    if (
      isRecord(update) &&
      (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') &&
      (update.status === 'completed' || update.status === 'failed') &&
      typeof update.toolCallId === 'string'
    ) {
      this.current?.endCall(update.toolCallId)
    }
  }
}
