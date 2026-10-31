import { agentSessionRefusalError } from '../../../shared/agent-session-wire-refusals'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import {
  AGENT_SESSION_SETTLED_BODY_CAPABILITY,
  AGENT_SESSION_SETTLED_BODY_MAX_UNITS,
  isExactSettledApprovalBody,
  type AgentSessionSettledBodyRead,
  type AgentSessionSettledBodyPiece
} from '../../../shared/agent-session-settled-body'
import { agentSessionJsonPiece } from '../../../shared/agent-session-json-pieces'
import { stringifyJsonWithinByteLimit } from '../../../shared/node-bounded-json-stringify'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'

const presentations = [
  new WeakMap<AgentJournalRenderItem, AgentJournalRenderItem>(),
  new WeakMap<AgentJournalRenderItem, AgentJournalRenderItem>()
]
export function settledBodyPresentation(
  item: AgentJournalRenderItem,
  supported: boolean
): AgentJournalRenderItem {
  const body = item.body
  if (
    body.kind !== 'approval' ||
    !body.form ||
    (body.resolution.state !== 'resolved' && body.resolution.state !== 'cancelled')
  ) {
    return item
  }
  const cache = presentations[supported ? 1 : 0]!
  const prior = cache.get(item)
  if (prior) {
    return prior
  }
  const result: AgentJournalRenderItem = {
    ...item,
    body: {
      kind: 'approval',
      title: body.title.slice(0, 80),
      detail: null,
      options: [],
      resolution: {
        state: body.resolution.state,
        selectedOptionId: null,
        resolvedBy: null,
        resolvedAt: null
      }
    },
    ...(supported
      ? {
          settledBody: {
            contract: AGENT_SESSION_SETTLED_BODY_CAPABILITY,
            version: 'approval-json.v1',
            state: body.resolution.state
          }
        }
      : {})
  }
  cache.set(item, result)
  return result
}

// Journal-owned objects are immutable; only these finite serialized representations are cached.
const serializations = new Map<
  AgentJournalRenderItem['body'],
  { json: string; journal: WeakRef<AgentSessionJournal>; itemId: string; epoch: string }
>()
let retainedUnits = 0
export function readSettledBodyPiece(
  journal: AgentSessionJournal,
  request: AgentSessionSettledBodyRead
): AgentSessionSettledBodyPiece {
  const item = journal.item(request.itemId)
  if (
    journal.cursor().epoch !== request.epoch ||
    !item ||
    item.revision !== request.revision ||
    request.contract !== AGENT_SESSION_SETTLED_BODY_CAPABILITY ||
    request.version !== 'approval-json.v1' ||
    item.body.kind !== 'approval' ||
    !item.body.form ||
    item.body.resolution.state !== request.state
  ) {
    throw agentSessionRefusalError('agent_session_item_revision_stale', { reason: 'promptMoved' })
  }
  let json = serializations.get(item.body)?.json
  if (json === undefined) {
    if (!isExactSettledApprovalBody(item.body, request.state)) {
      throw agentSessionRefusalError('agent_session_item_revision_stale', { reason: 'promptMoved' })
    }
    // Charge maximum before serialization; slices in returned replies retain the parent too.
    while (
      serializations.size >= 8 ||
      retainedUnits + AGENT_SESSION_SETTLED_BODY_MAX_UNITS > 16 * 1024 * 1024
    ) {
      const oldest = serializations.keys().next().value
      if (!oldest) {
        throw new Error('Saved answer read busy')
      }
      retainedUnits -= serializations.get(oldest)!.json.length
      serializations.delete(oldest)
    }
    json = stringifyJsonWithinByteLimit(item.body, AGENT_SESSION_SETTLED_BODY_MAX_UNITS).serialized
    serializations.set(item.body, {
      json,
      journal: new WeakRef(journal),
      itemId: item.itemId,
      epoch: journal.cursor().epoch
    })
    retainedUnits += json.length
  }
  const { cursor: _cursor, ...source } = request
  const piece = agentSessionJsonPiece(json, request.cursor)
  // Detach the returned fragment so an outbound reply cannot pin an evicted full serializer.
  const fragment: unknown = JSON.parse(JSON.stringify(piece.json))
  if (typeof fragment !== 'string') {
    throw new Error('Invalid content fragment')
  }
  return { source, ...piece, total: json.length, json: fragment }
}

export function invalidateSettledBodySerializations(
  journal: AgentSessionJournal,
  closing = false
): void {
  for (const [body, entry] of serializations) {
    const owner = entry.journal.deref()
    if (
      !owner ||
      (owner === journal &&
        (closing ||
          journal.cursor().epoch !== entry.epoch ||
          journal.item(entry.itemId)?.body !== body))
    ) {
      retainedUnits -= entry.json.length
      serializations.delete(body)
    }
  }
}
export function settledBodySerializationEvidence() {
  return { entries: serializations.size, retainedBytes: retainedUnits * 2 }
}

export function settledBodyPieceReader(
  conversation: (sessionId: string) => Promise<{ journal: AgentSessionJournal }>
) {
  return async (request: AgentSessionSettledBodyRead) =>
    readSettledBodyPiece((await conversation(request.sessionId)).journal, request)
}
