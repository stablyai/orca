import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { RuntimeClient, RuntimeRpcSuccess } from './runtime-client'
import { RuntimeClientError } from './runtime/types'
import type { RuntimeStatus, RuntimeMobileSessionTabsResult } from '../shared/runtime-types'
import type { AgentSessionHistoryResult } from '../shared/agent-session-wire'
import type { AgentSessionCurrentRequest } from '../shared/agent-session-current-requests'
import { isAdmissibleAgentJournalRenderItem } from '../shared/agent-session-journal-schemas'
import { AGENT_SESSION_CURRENT_REQUESTS_CLIENT_CAPABILITY } from '../shared/agent-session-current-requests-capability'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../shared/protocol-version'
import { worktreeIdsEqual } from '../shared/worktree/id'

export type AgentRequestClient = Pick<RuntimeClient, 'call'>
export type AgentRequestScope = { worktree: string; sessionId: string; turnItemId?: string }

export const AgentRequestMarkerSchema = z.object({
  contract: z.literal(AGENT_SESSION_CURRENT_REQUESTS_CLIENT_CAPABILITY),
  sessionId: z.string().min(1),
  epoch: z.string().min(1),
  publisher: z.string().uuid(),
  revision: z.number().int().positive(),
  owner: z.string().min(1),
  version: z.string().uuid()
})
const Piece = z.object({
  marker: AgentRequestMarkerSchema,
  json: z.string().max(24 * 1024),
  nextCursor: z.number().int().nonnegative().nullable(),
  restart: z.literal(true).optional()
})
type RequestMarker = z.infer<typeof AgentRequestMarkerSchema>
export type AgentRequestInventory = {
  runtimeId: string
  workspaceId: string
  sessionId: string
  fence: number
  marker: RequestMarker
  turnItemId?: string
  requests: AgentSessionCurrentRequest[]
}

/** Refuses an unverifiable read before callers can treat a partial view as actionable. */
export function requestRefusal(message: string): never {
  throw new RuntimeClientError('agent_request_unverifiable', message)
}

/** Rejects replies from an incarnation other than the runtime pinned for this collection. */
export function requireSameRuntime(response: RuntimeRpcSuccess<unknown>, runtimeId: string): void {
  if (response._meta.runtimeId !== runtimeId) {
    requestRefusal(
      'The execution runtime changed. Inspect the scoped request again; do not answer it.'
    )
  }
}

/** Returns the responding runtime ID only when authoritative native-request reads are supported. */
export async function readRequestHost(client: AgentRequestClient): Promise<string> {
  const response = await client.call<RuntimeStatus>('status.get')
  const capabilities = response.result.capabilities ?? []
  if (
    response.result.runtimeId !== response._meta.runtimeId ||
    !capabilities.includes(STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY) ||
    !capabilities.includes(AGENT_SESSION_CURRENT_REQUESTS_CLIENT_CAPABILITY)
  ) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      'This host cannot authoritatively list native requests. Update Orca on the execution host.'
    )
  }
  return response._meta.runtimeId
}

/** Proves one native tab belongs to the explicit scope and returns its canonical workspace ID. */
export async function verifyRequestWorkspace(
  client: AgentRequestClient,
  scope: AgentRequestScope,
  runtimeId: string
): Promise<string> {
  const response = await client.call<RuntimeMobileSessionTabsResult>('session.tabs.list', {
    worktree: scope.worktree
  })
  requireSameRuntime(response, runtimeId)
  const snapshot = response.result
  if (
    snapshot.agentSessionsUnverifiable ||
    typeof snapshot.worktree !== 'string' ||
    !Array.isArray(snapshot.tabs)
  ) {
    requestRefusal('The host cannot verify this workspace and native session.')
  }
  const matches = snapshot.tabs.filter(
    (tab) => tab.type === 'agent-session' && tab.sessionId === scope.sessionId
  )
  if (matches.length !== 1) {
    requestRefusal('The named native session is not uniquely present in the explicit workspace.')
  }
  return snapshot.worktree
}

/** Reads a minimal history checkpoint and refuses resets or missing session fence evidence. */
async function readFence(
  client: AgentRequestClient,
  sessionId: string,
  runtimeId: string
): Promise<{ fence: number; epoch: string }> {
  const response = await client.call<AgentSessionHistoryResult>('agentSession.history', {
    sessionId,
    direction: 'tail',
    limit: 1
  })
  requireSameRuntime(response, runtimeId)
  const page = response.result.page
  if (
    !response.result.ok ||
    page.sessionId !== sessionId ||
    !Number.isSafeInteger(page.fence) ||
    page.fence === undefined ||
    page.fence <= 0 ||
    typeof page.epoch !== 'string'
  ) {
    requestRefusal('A current native-session fence and journal epoch could not be established.')
  }
  return { fence: page.fence, epoch: page.epoch }
}

/** Compares every owner and version field required to join pages from one request snapshot. */
export function sameRequestMarker(left: RequestMarker, right: RequestMarker): boolean {
  return (
    left.contract === right.contract &&
    left.sessionId === right.sessionId &&
    left.epoch === right.epoch &&
    left.publisher === right.publisher &&
    left.revision === right.revision &&
    left.owner === right.owner &&
    left.version === right.version
  )
}

/** Reads one bounded page and rejects an invalid contract, session identity or runtime reply. */
async function piece(
  client: AgentRequestClient,
  sessionId: string,
  runtimeId: string,
  version: string,
  cursor?: number
) {
  const response = await client.call<unknown>('agentSession.currentRequests', {
    sessionId,
    version,
    ...(cursor === undefined ? {} : { cursor })
  })
  requireSameRuntime(response, runtimeId)
  const parsed = Piece.safeParse(response.result)
  if (!parsed.success || parsed.data.marker.sessionId !== sessionId) {
    requestRefusal('The host returned an invalid current-request page.')
  }
  return parsed.data
}

/** Admits only complete, unique pending prompts; malformed rows invalidate the entire snapshot. */
function pendingRequests(value: unknown): AgentSessionCurrentRequest[] {
  if (!Array.isArray(value)) {
    requestRefusal('The current-request snapshot is not a complete array.')
  }
  const result: AgentSessionCurrentRequest[] = []
  const ids = new Set<string>()
  for (const entry of value) {
    if (
      !isAdmissibleAgentJournalRenderItem(entry) ||
      (entry.body.kind !== 'approval' && entry.body.kind !== 'question') ||
      entry.body.resolution.state !== 'pending' ||
      entry.revision <= 0 ||
      entry.shortened ||
      ids.has(entry.itemId)
    ) {
      requestRefusal('The current-request snapshot contains an invalid or duplicate prompt.')
    }
    ids.add(entry.itemId)
    result.push({ ...entry, body: entry.body })
  }
  return result
}

/** Collects a bounded authoritative snapshot, refusing changes to its runtime, scope or owner. */
export async function listAgentRequests(
  client: AgentRequestClient,
  scope: AgentRequestScope,
  expectedRuntimeId?: string
): Promise<AgentRequestInventory> {
  const runtimeId = await readRequestHost(client)
  if (expectedRuntimeId !== undefined && runtimeId !== expectedRuntimeId) {
    requestRefusal('The request file names a different execution runtime.')
  }
  const workspaceId = await verifyRequestWorkspace(client, scope, runtimeId)
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = await readFence(client, scope.sessionId, runtimeId)
    // A deliberately stale version obtains the host's current marker without a subscription.
    const bootstrap = await piece(client, scope.sessionId, runtimeId, randomUUID())
    const marker = bootstrap.marker
    if (marker.epoch !== before.epoch) {
      continue
    }
    let cursor = 0
    let json = ''
    let complete = false
    for (let page = 0; page < 64; page += 1) {
      const next = await piece(client, scope.sessionId, runtimeId, marker.version, cursor)
      if (next.restart || !sameRequestMarker(marker, next.marker)) {
        break
      }
      json += next.json
      if (json.length > 1024 * 1024) {
        requestRefusal('The current-request snapshot exceeds the CLI limit.')
      }
      if (next.nextCursor === null) {
        complete = true
        break
      }
      if (next.json.length === 0 || next.nextCursor !== cursor + next.json.length) {
        requestRefusal('The current-request cursor did not advance exactly.')
      }
      cursor = next.nextCursor
    }
    if (!complete) {
      continue
    }
    let decoded: unknown
    try {
      decoded = JSON.parse(json)
    } catch {
      requestRefusal('The current-request snapshot is incomplete JSON.')
    }
    const requests = pendingRequests(decoded)
    const after = await readFence(client, scope.sessionId, runtimeId)
    const confirmed = await piece(client, scope.sessionId, runtimeId, marker.version, 0)
    const workspaceAfter = await verifyRequestWorkspace(client, scope, runtimeId)
    if (!worktreeIdsEqual(workspaceAfter, workspaceId)) {
      requestRefusal('The native session changed workspace while its requests were read.')
    }
    if (
      before.fence !== after.fence ||
      before.epoch !== after.epoch ||
      confirmed.restart ||
      !sameRequestMarker(marker, confirmed.marker)
    ) {
      continue
    }
    return {
      runtimeId,
      workspaceId,
      sessionId: scope.sessionId,
      fence: after.fence,
      marker,
      ...(scope.turnItemId === undefined ? {} : { turnItemId: scope.turnItemId }),
      requests:
        scope.turnItemId === undefined
          ? requests
          : requests.filter(
              (request) =>
                request.turnScope?.kind === 'turn' &&
                request.turnScope.turnItemId === scope.turnItemId
            )
    }
  }
  requestRefusal('The request owner, revision or journal changed during collection. Read it again.')
}
