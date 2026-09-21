import { AGENT_SESSION_PAYLOAD_READ_MAX_LIMIT } from '../../../shared/rpc-contract/structured-agent-session-params'
import { PayloadReadError, readSessionPayload } from '../agent-session-journal/journal-payload-read'
import type { JournalPayloadRange } from '../agent-session-journal/journal-payload-store'

export type StructuredAgentSessionPayloadReadParams = {
  sessionId: string
  digest: string
  offset?: number
  limit?: number
  /** Defaults to the cap the `agentSession.readPayload` contract already declares. */
  maxLimit?: number
}

type PayloadOwnerRecord = { sessionId: string; location: { workspaceId: string } }

type PayloadReadDeps = {
  journalRoot: string
  store: { getRecord(sessionId: string): PayloadOwnerRecord | null | undefined }
}

/** Exact bytes of a retained bounded payload, admitted only when this session's own
 *  journal references the digest; the record must exist and be readable here. */
export function readStructuredSessionPayload(
  deps: PayloadReadDeps,
  params: StructuredAgentSessionPayloadReadParams
): JournalPayloadRange {
  const record = deps.store.getRecord(params.sessionId)
  if (!record) {
    throw new PayloadReadError(
      'payload_not_referenced',
      `Session ${params.sessionId} is not known to this host.`
    )
  }
  return readSessionPayload({
    journalRoot: deps.journalRoot,
    owner: { sessionId: record.sessionId, workspaceId: record.location.workspaceId },
    digest: params.digest,
    offset: params.offset,
    limit: params.limit,
    maxLimit: params.maxLimit ?? AGENT_SESSION_PAYLOAD_READ_MAX_LIMIT
  })
}

/** The host facade's `readPayload`, bound lazily so it reads the deps the host was
 *  constructed with rather than pulling the payload shapes into that file. */
export function structuredAgentSessionPayloadReader(
  deps: () => PayloadReadDeps
): (params: StructuredAgentSessionPayloadReadParams) => JournalPayloadRange {
  return (params) => readStructuredSessionPayload(deps(), params)
}
