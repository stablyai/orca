import { randomUUID } from 'node:crypto'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import type {
  AgentSessionCurrentRequestsMarker,
  AgentSessionCurrentRequestsPiece,
  AgentSessionCurrentRequestsRead
} from '../../../shared/agent-session-current-requests-wire'
import { AGENT_SESSION_CURRENT_REQUESTS_CLIENT_CAPABILITY } from '../../../shared/agent-session-current-requests-capability'
import type { CurrentRequestsContract } from '../../../shared/agent-session-current-requests-capability'
import type { CurrentRequestsPayload } from '../../../shared/agent-session-current-requests-wire'

export type CurrentRequestsSubscriber = {
  readsCurrentRequests?: boolean
  requestContract?: CurrentRequestsContract
  requestVersion?: string
}

export type CurrentRequestsProjection = {
  identity: string
  marker: AgentSessionCurrentRequestsMarker
  items?: AgentJournalRenderItem[] | CurrentRequestsPayload
  json?: string
}
type ReadableCurrentRequestsProjection = CurrentRequestsProjection & {
  items: AgentJournalRenderItem[] | CurrentRequestsPayload
  json: string
}
function isReadable(
  projection: CurrentRequestsProjection | undefined
): projection is ReadableCurrentRequestsProjection {
  return projection?.json !== undefined && projection.items !== undefined
}
type Publication = {
  current: CurrentRequestsProjection
  complete?: { items: CurrentRequestsPayload; json: string }
}
const projections = new WeakMap<object, Map<CurrentRequestsContract, Publication>>()
// Even six escaped bytes per UTF-16 unit leave room for the RPC and phone envelopes.
const REQUEST_PIECE_UNITS = 24 * 1024

export function currentRequestsProjection(
  source: object & { cursor?: () => { epoch: string } },
  sessionId: string,
  work: { actionablePrompts: () => AgentJournalRenderItem[]; viewKey: () => string },
  contract: CurrentRequestsContract = AGENT_SESSION_CURRENT_REQUESTS_CLIENT_CAPABILITY,
  payload?: CurrentRequestsPayload,
  epoch = source.cursor?.().epoch ?? 'source'
): ReadableCurrentRequestsProjection {
  let items = payload ?? work.actionablePrompts()
  let versions = projections.get(source)
  if (!versions) {
    versions = new Map()
    projections.set(source, versions)
  }
  const retained = versions.get(contract)
  const previous = retained?.current
  const memo = retained?.complete
  const semantic =
    payload &&
    memo &&
    payload.asyncQuestions !== null &&
    memo.items.asyncQuestions === payload.asyncQuestions &&
    memo.items.blocking === payload.blocking &&
    memo.items.context.sessionId === payload.context.sessionId &&
    memo.items.context.boundary === payload.context.boundary
      ? memo
      : undefined
  if (semantic) {
    items = semantic.items
  }
  const identity = previous?.identity ?? randomUUID()
  const owner = `${identity}:${work.viewKey()}`
  if (
    isReadable(previous) &&
    previous.items === items &&
    previous.marker.epoch === epoch &&
    previous.marker.owner === owner &&
    previous.marker.sessionId === sessionId
  ) {
    return previous
  }
  const projection: ReadableCurrentRequestsProjection = {
    identity,
    items,
    json: semantic?.json ?? JSON.stringify(items),
    marker: {
      contract,
      sessionId,
      epoch,
      publisher: identity,
      revision: (previous?.marker.revision ?? 0) + 1,
      owner,
      version: randomUUID()
    }
  }
  versions.set(contract, {
    current: projection,
    complete:
      payload && payload.asyncQuestions !== null
        ? { items: semantic?.items ?? payload, json: projection.json }
        : memo
  })
  return projection
}

/** The same source publisher can announce unavailability without claiming a semantic context. */
export function unavailableCurrentRequestsProjection(
  source: object,
  sessionId: string,
  contract: CurrentRequestsContract,
  resource: string
): CurrentRequestsProjection {
  let versions = projections.get(source)
  if (!versions) {
    versions = new Map()
    projections.set(source, versions)
  }
  const retained = versions.get(contract)
  const previous = retained?.current
  const identity = previous?.identity ?? randomUUID()
  const owner = `${identity}:${resource}`
  if (previous && previous.json === undefined && previous.marker.owner === owner) {
    return previous
  }
  const projection: CurrentRequestsProjection = {
    identity,
    marker: {
      contract,
      sessionId,
      epoch: resource,
      publisher: identity,
      owner,
      revision: (previous?.marker.revision ?? 0) + 1,
      version: randomUUID()
    }
  }
  versions.set(contract, { current: projection, complete: retained?.complete })
  return projection
}

/** Only the current projection is retained; superseded cursors restart at its version. */
export function readCurrentRequestsPiece(
  projection: CurrentRequestsProjection,
  request: AgentSessionCurrentRequestsRead
): AgentSessionCurrentRequestsPiece {
  if (request.version !== projection.marker.version) {
    return { marker: projection.marker, json: '', nextCursor: 0, restart: true }
  }
  const json = projection.json
  if (json === undefined) {
    throw new Error('Current questions temporarily unavailable')
  }
  const cursor = request.cursor ?? 0
  if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor >= json.length) {
    throw new Error('Invalid current-request cursor')
  }
  const end = Math.min(cursor + REQUEST_PIECE_UNITS, json.length)
  return {
    marker: projection.marker,
    json: json.slice(cursor, end),
    nextCursor: end === json.length ? null : end
  }
}
