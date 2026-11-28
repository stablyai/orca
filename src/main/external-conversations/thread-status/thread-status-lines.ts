// The visible lines a sent connector call put in a conversation, read from its request: a bot's
// answer, reply or post there, or one of Orca's own status lines. Nothing counts unless it was taken.
import { CONNECTOR_ACTIONS_PATH } from '../../../shared/connector-action-contract'
import { CONNECTOR_PATHS } from '../../../shared/connectors/connector-cloud-contract'
import {
  CONNECTOR_SOURCES,
  type ConnectorSource
} from '../../../shared/connectors/external-conversation-link'
import { connectorActionIntoThread } from '../../connector-cloud/connector-action-into-thread'

/** Orca's own status lines carry reply ids with this prefix. */
export const THREAD_STATUS_REPLY_PREFIX = 'status-'

export type ThreadConversation = { source: ConnectorSource; externalId: string }

export type ThreadLine = {
  conversation: ThreadConversation
  kind: 'host' | 'bot'
  replyId?: string
}

export type ThreadLineNotes = {
  lines: ThreadLine[]
  /** Prompts shown in (open) or answered for (closed) a conversation. */
  prompts: { conversation: ThreadConversation; promptId: string; open: boolean }[]
  /** Conversations a turn end was taken for: their prompts are over. */
  turnEnds: ThreadConversation[]
}

const NONE: ThreadLineNotes = { lines: [], prompts: [], turnEnds: [] }

export function threadLinesOf(
  path: string,
  body: unknown,
  result: { ok: boolean; value?: unknown }
): ThreadLineNotes {
  if (!result.ok || !isRecord(body)) {
    return NONE
  }
  if (path === CONNECTOR_PATHS.replies) {
    const conversation = conversationOf(body.conversation)
    const replyId = typeof body.replyId === 'string' ? body.replyId : undefined
    if (!conversation) {
      return NONE
    }
    const host = replyId?.startsWith(THREAD_STATUS_REPLY_PREFIX) === true
    return {
      ...NONE,
      lines: [{ conversation, kind: host ? 'host' : 'bot', ...(replyId ? { replyId } : {}) }]
    }
  }
  if (path === CONNECTOR_PATHS.events) {
    return Array.isArray(body.events) ? eventNotes(body.events) : NONE
  }
  if (path === CONNECTOR_ACTIONS_PATH) {
    return actionNotes(body, result.value)
  }
  return NONE
}

function eventNotes(events: readonly unknown[]): ThreadLineNotes {
  const notes: ThreadLineNotes = { lines: [], prompts: [], turnEnds: [] }
  for (const event of events) {
    if (!isRecord(event)) {
      continue
    }
    const conversation = conversationOf(event.conversation)
    if (!conversation) {
      continue
    }
    if (event.kind === 'reply' && event.outcome !== 'quiet') {
      notes.lines.push({ conversation, kind: 'bot' })
    } else if (event.kind === 'turn-ended') {
      // It ends the prompts shown before it in this batch too; the ones after it stay open.
      notes.prompts = notes.prompts.filter(
        (prompt) => !sameConversation(prompt.conversation, conversation)
      )
      notes.turnEnds.push(conversation)
      const said =
        event.stateOnly !== true &&
        (Boolean(event.lastAssistantMessage) || event.failure !== undefined)
      if (said && (event.origin !== 'local' || event.mirror === true)) {
        notes.lines.push({ conversation, kind: 'bot' })
      }
    } else if (event.kind === 'prompt' && isRecord(event.prompt)) {
      const { promptId } = event.prompt
      if (typeof promptId !== 'string') {
        continue
      }
      if (event.answered === true) {
        notes.prompts.push({ conversation, promptId, open: false })
      } else if (event.prompt.raisedBy !== 'orca') {
        notes.prompts.push({ conversation, promptId, open: true })
        notes.lines.push({ conversation, kind: 'bot' })
      }
    }
  }
  return notes
}

function actionNotes(body: Record<string, unknown>, answer: unknown): ThreadLineNotes {
  const conversation = conversationOf(body.conversation)
  const args = isRecord(body.args) ? body.args : {}
  if (
    !conversation ||
    !isRecord(answer) ||
    answer.ok !== true ||
    typeof body.verb !== 'string' ||
    args.postAt !== undefined ||
    !connectorActionIntoThread({
      verb: body.verb,
      args,
      ref: typeof body.ref === 'string' ? body.ref : undefined,
      conversation
    })
  ) {
    return NONE
  }
  return { ...NONE, lines: [{ conversation, kind: 'bot' }] }
}

function conversationOf(value: unknown): ThreadConversation | null {
  if (!isRecord(value) || typeof value.externalId !== 'string') {
    return null
  }
  const source = CONNECTOR_SOURCES.find((known) => known === value.source)
  return source ? { source, externalId: value.externalId } : null
}

function sameConversation(a: ThreadConversation, b: ThreadConversation): boolean {
  return a.source === b.source && a.externalId === b.externalId
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
