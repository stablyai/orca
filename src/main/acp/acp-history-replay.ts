// Replay grouping uses provider message/turn IDs and preserves source arrival order.

import { z } from 'zod'
import type { NativeChatBlock } from '../../shared/native-chat-types'

/** What one load may keep for catch-up; a larger history is not caught up at all. */
const LOAD_HISTORY_MAX_FRAMES = 20_000
const LOAD_HISTORY_MAX_BYTES = 16 * 1024 * 1024

/** One notification the agent sent while it replayed its history, as received. */
export type AcpLoadHistoryFrame = { method: string; params: unknown }

/** A bounded copy of what one session's load replayed, in arrival order, its own frames only. */
export class AcpLoadHistory {
  private kept: AcpLoadHistoryFrame[] | null = []
  private bytes = 0

  constructor(
    private readonly providerSessionId: string,
    private readonly onOverflow?: () => void
  ) {}

  keep(method: string, params: unknown): void {
    if (!this.kept || sessionSchema.safeParse(params).data?.sessionId !== this.providerSessionId) {
      return
    }
    this.bytes += Buffer.byteLength(JSON.stringify(params), 'utf8')
    this.kept.push({ method, params })
    if (this.kept.length > LOAD_HISTORY_MAX_FRAMES || this.bytes > LOAD_HISTORY_MAX_BYTES) {
      this.kept = null
      this.onOverflow?.()
    }
  }

  /** Null once the history outgrew what a load keeps. */
  frames(): AcpLoadHistoryFrame[] | null {
    return this.kept
  }
}

/** Where a replayed turn's id comes from. */
export type AcpHistoryTurnIdentity = 'prompt-id' | 'user-message-id'

type AcpHistoryUser = {
  blocks: NativeChatBlock[]
  boundary: AcpLoadHistoryFrame
  eventId?: string
}

export type AcpHistoryTurn = {
  /** The agent's id for the turn; null when its replay names none. */
  turn: string | null
  /** The execution's root message, in the order its chunks came. */
  user: AcpHistoryUser
  textOnly: boolean
  /** Later messages and output in source order, no longer marked as replay. */
  observations: (AcpHistoryUser | AcpLoadHistoryFrame)[]
  /** Every message id the replay gave this turn (OpenCode): the person's and the agent's. */
  messageIds: string[]
  /** When the agent recorded the person's message (Grok), on the agent host's clock. */
  startedAt: number | null
}

/** A replayed turn under the agent's own id. */
export type AcpIdentifiedHistoryTurn = AcpHistoryTurn & { turn: string }

const sessionSchema = z.object({ sessionId: z.string() })
const looseRecord = z.record(z.string(), z.unknown())
const frameSchema = z.looseObject({
  update: z.looseObject({
    sessionUpdate: z.string(),
    messageId: z.string().optional(),
    prompt_id: z.string().optional(),
    content: z.unknown().optional(),
    _meta: z.looseObject({ promptIndex: z.number().int().nonnegative().optional() }).optional()
  }),
  _meta: z
    .looseObject({
      promptId: z.string().optional(),
      eventId: z.string().min(1).optional(),
      agentTimestampMs: z.number().optional()
    })
    .optional()
})
const contentSchema = z.discriminatedUnion('type', [
  z.looseObject({
    type: z.literal('text'),
    text: z.string(),
    _meta: z.looseObject({ displayText: z.unknown().optional() }).optional()
  }),
  z.looseObject({ type: z.literal('image'), mimeType: z.string(), data: z.string() }),
  z.looseObject({ type: z.literal('resource_link'), uri: z.string(), name: z.string().optional() }),
  z.looseObject({
    type: z.literal('resource'),
    resource: z.looseObject({ uri: z.string(), text: z.string().optional() })
  })
])

/** OpenCode names reasoning `<message id>:reasoning:<n>`; the message is what its store keys. */
const REASONING_SUFFIX = /:reasoning:\d+$/

function userBlock(block: z.infer<typeof contentSchema>): NativeChatBlock {
  switch (block.type) {
    case 'text':
      return {
        type: 'text',
        text: typeof block._meta?.displayText === 'string' ? block._meta.displayText : block.text
      }
    case 'image':
      return { type: 'image-ref', url: `data:${block.mimeType};base64,${block.data}` }
    case 'resource_link':
      return { type: 'text', text: block.name ?? block.uri }
    case 'resource':
      return { type: 'text', text: block.resource.text ?? block.resource.uri }
  }
}

/** The frame with the agent's replay marking removed, so it reads as the turn it records. */
function unmarked(frame: AcpLoadHistoryFrame): AcpLoadHistoryFrame {
  const params = looseRecord.safeParse(frame.params)
  const meta = params.success ? looseRecord.safeParse(params.data._meta) : null
  if (!params.success || !meta?.success) {
    return frame
  }
  const { isReplay: _isReplay, ...rest } = meta.data
  return { method: frame.method, params: { ...params.data, _meta: rest } }
}

/** The replay's turns in the agent's order. Throws when one turn names two prompt ids. */
export function acpHistoryTurns(
  frames: readonly AcpLoadHistoryFrame[],
  identity: AcpHistoryTurnIdentity,
  check: () => void = () => {}
): AcpHistoryTurn[] {
  const turns: AcpHistoryTurn[] = []
  const messageIds = new Set<string>()
  let current: AcpHistoryTurn | undefined
  let lastUser: AcpHistoryUser | undefined
  let userKey: string | number | undefined
  let inUser = false
  let marked = false
  let ended = false
  const nameTurn = (turn: AcpHistoryTurn, id: string | undefined) => {
    if (id === undefined || id === turn.turn) {
      return
    }
    if (turn.turn !== null) {
      throw new Error('conflicting-history-turn')
    }
    turn.turn = id
  }
  for (const frame of frames) {
    check()
    const parsed = frameSchema.safeParse(frame.params)
    if (!parsed.success) {
      throw new Error('unrecognised-history-frame')
    }
    const { update, _meta: meta } = parsed.data
    if (update.sessionUpdate === 'user_message_chunk') {
      const key = identity === 'user-message-id' ? update.messageId : update._meta?.promptIndex
      marked ||= update._meta?.promptIndex !== undefined
      // After marked roots appear, unmarked users stay inside their execution.
      const root =
        identity === 'user-message-id'
          ? !inUser || userKey !== key
          : update._meta?.interjection !== true &&
            (!marked || key !== undefined) &&
            (!inUser || userKey !== key)
      if (update._meta?.hostTurn === true || (identity === 'user-message-id' && !key)) {
        throw new Error('unattributed-history-user')
      }
      if (root) {
        messageIds.clear()
        current = {
          turn: null,
          user: { blocks: [], boundary: unmarked(frame) },
          textOnly: true,
          observations: [],
          messageIds: [],
          startedAt: meta?.agentTimestampMs ?? null
        }
        turns.push(current)
        lastUser = current.user
        ended = false
        if (identity === 'user-message-id') {
          nameTurn(current, update.messageId)
        }
      } else if (!current || ended) {
        throw new Error('unattributed-history-user')
      } else if (
        lastUser !== current.user ||
        !inUser ||
        userKey !== key ||
        update._meta?.interjection === true
      ) {
        if (!meta?.eventId) {
          throw new Error('unkeyed-history-user')
        }
        if (!inUser || lastUser?.eventId !== meta.eventId) {
          lastUser = { blocks: [], boundary: unmarked(frame), eventId: meta.eventId }
          current.observations.push(lastUser)
        }
      }
      if (!current || !lastUser) {
        throw new Error('unattributed-history-user')
      }
      inUser = true
      userKey = key
      const raw = contentSchema.safeParse(update.content)
      if (!raw.success) {
        throw new Error('unrecognised-history-user-content')
      }
      const hidden = update._meta?.hideFromScrollback === true
      if (lastUser === current.user ? raw.data.type !== 'text' || hidden : !hidden) {
        current.textOnly = false
      }
      if (!hidden) {
        lastUser.blocks.push(userBlock(raw.data))
      }
    } else if (current) {
      inUser = false
      current.observations.push(unmarked(frame))
      if (identity === 'prompt-id') {
        nameTurn(current, meta?.promptId)
        if (update.sessionUpdate === 'turn_completed') {
          nameTurn(current, update.prompt_id)
          ended = true
        }
      }
    } else {
      continue
    }
    if (identity === 'user-message-id' && update.messageId) {
      const id = update.messageId.replace(REASONING_SUFFIX, '')
      if (!messageIds.has(id)) {
        messageIds.add(id)
        current.messageIds.push(id)
      }
    }
  }
  if (turns.some((turn) => turn.turn === null)) {
    throw new Error('unattributed-history-turn')
  }
  return turns
}

export function acpHistoryFrameTime(frame: AcpLoadHistoryFrame): number | null {
  return frameSchema.safeParse(frame.params).data?._meta?.agentTimestampMs ?? null
}
