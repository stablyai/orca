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

const ENVELOPE_SCAN_CHARS = 4096
/** A long line's fields are read from its start and end; no line is parsed here. */
const FIELD_WINDOW_CHARS = 4096
/** More open items than this can't be real; the oldest stay held, so nothing is acked past them. */
const MAX_OPEN_ITEMS = 256
const CHUNKS = new Set(['agent_message_chunk', 'agent_thought_chunk'])
/** Updates after which a session's message chunks don't continue (as the translator numbers them). */
const MESSAGE_ENDS = new Set(['user_message_chunk', 'tool_call', 'tool_call_update', 'plan'])

type UpdateFields = {
  sessionId?: string
  sessionUpdate?: string
  messageId?: string
  toolCallId?: string
}

/** A key outside any string: an unescaped quote can't sit inside a JSON string. */
const field = (name: string): RegExp => new RegExp(`"${name}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`)
const SESSION_ID = field('sessionId')
const SESSION_UPDATE = field('sessionUpdate')
const MESSAGE_ID = field('messageId')
const TOOL_CALL_ID = field('toolCallId')

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The fields the floor needs, scanned from the line's ends. A call's end is read by the
 *  connection, which parses every line anyway (`AcpRelayTurns.observeUpdate`). */
function updateFields(line: string): UpdateFields {
  const windows =
    line.length <= 2 * FIELD_WINDOW_CHARS
      ? [line]
      : [line.slice(0, FIELD_WINDOW_CHARS), line.slice(-FIELD_WINDOW_CHARS)]
  const find = (pattern: RegExp): string | undefined =>
    windows.map((text) => pattern.exec(text)?.[1]).find((value) => value !== undefined)
  const sessionUpdate = find(SESSION_UPDATE)
  if (sessionUpdate === 'tool_call') {
    return { sessionId: find(SESSION_ID), sessionUpdate, toolCallId: find(TOOL_CALL_ID) }
  }
  return {
    sessionId: find(SESSION_ID),
    sessionUpdate,
    ...(sessionUpdate && CHUNKS.has(sessionUpdate) ? { messageId: find(MESSAGE_ID) } : {})
  }
}

const first = (open: Map<string, { seq: number }>): number | null =>
  open.values().next().value?.seq ?? null

/**
 * One attach's floor. Acks stay below the start of each open call (until its final status or its
 * prompt's end) and each open message (until a call, plan or user chunk of its session, or its
 * prompt's end), so a reattach replays each from its first line and rewrites its row whole.
 * Messages without ids are numbered within their prompt's turn, so while a prompt runs, until the
 * agent shows it gives ids (and in any turn with one without), the turn's first line holds too:
 * the replay numbers them again as the live run did. Only session updates are read past their
 * envelope.
 */
class AcpRelayAckFloor implements ProviderRelayAckFloor {
  /** Insertion order is seq order, so the first entry is the earliest. */
  private readonly calls = new Map<string, { seq: number }>()
  private readonly messages = new Map<string, { seq: number; session?: string }>()
  private firstSeq: number | null = null
  /** The running prompt's first line; null between prompts and before its first line. */
  private turnStart: number | null = null
  private turnPending: boolean
  private numbered = false
  private givesIds = false

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
    const { properties } = leadingJsonEnvelope(line.slice(0, ENVELOPE_SCAN_CHARS), {
      stopAtContainer: true,
      maxFields: 8
    })
    const method = properties.find((property) => property.key === 'method')?.value
    if (typeof method !== 'string' || !ACP_SESSION_UPDATE_METHODS.has(method)) {
      return
    }
    const update = updateFields(line)
    const kind = update.sessionUpdate
    if (kind && MESSAGE_ENDS.has(kind)) {
      for (const [id, message] of this.messages) {
        if (message.session === update.sessionId) {
          this.messages.delete(id)
        }
      }
    }
    if (kind && CHUNKS.has(kind)) {
      if (update.messageId === undefined) {
        this.numbered = true
      } else {
        this.givesIds = true
        this.open(this.messages, update.messageId, { seq, session: update.sessionId })
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

  /** The call reported its final status. */
  endCall(toolCallId: string): void {
    this.calls.delete(toolCallId)
  }

  /** Answered or failed: its calls Orca backgrounds are restated from their saved rows instead. */
  endTurn(): void {
    this.calls.clear()
    this.messages.clear()
    this.turnStart = null
    this.turnPending = false
    this.numbered = false
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
