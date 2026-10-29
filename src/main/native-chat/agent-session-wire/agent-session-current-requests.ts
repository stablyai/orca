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
  items: AgentJournalRenderItem[] | CurrentRequestsPayload
  json?: string
}
const projections = new WeakMap<object, Map<CurrentRequestsContract, CurrentRequestsProjection>>()
// Even six escaped bytes per UTF-16 unit leave room for the RPC and phone envelopes.
const REQUEST_PIECE_UNITS = 24 * 1024

export function currentRequestsProjection(
  source: object & { cursor?: () => { epoch: string } },
  sessionId: string,
  work: { actionablePrompts: () => AgentJournalRenderItem[]; viewKey: () => string },
  contract: CurrentRequestsContract = AGENT_SESSION_CURRENT_REQUESTS_CLIENT_CAPABILITY,
  payload?: CurrentRequestsPayload,
  epoch = source.cursor?.().epoch ?? 'source'
): CurrentRequestsProjection {
  const items = payload ?? work.actionablePrompts()
  let versions = projections.get(source)
  if (!versions) {
    versions = new Map()
    projections.set(source, versions)
  }
  const previous = versions.get(contract)
  const identity = previous?.identity ?? randomUUID()
  const owner = `${identity}:${work.viewKey()}`
  if (
    previous?.items === items &&
    previous.marker.epoch === epoch &&
    previous.marker.owner === owner &&
    previous.marker.sessionId === sessionId
  ) {
    return previous
  }
  const projection: CurrentRequestsProjection = {
    identity,
    items,
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
  versions.set(contract, projection)
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
  const json = (projection.json ??= JSON.stringify(projection.items))
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
