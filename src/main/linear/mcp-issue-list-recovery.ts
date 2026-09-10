import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { LinearMcpIssueListRequest } from '../../shared/linear/mcp-issue-list'
import type { LinearWorkspace } from '../../shared/linear/workspace-types'
import { stringifyJsonWithinByteLimit } from '../../shared/node-bounded-json-stringify'
import { linearError } from './issue-context-errors'
import { buildIssueFilter } from './mcp-issue-list-filter'

export const LIST_CONTEXT_BYTES = 64 * 1024
export const LIST_CURSOR_BYTES = 2048
const position = z
  .object({
    id: z.string().min(1),
    credentialRevision: z.number().int().nonnegative(),
    after: z.string().min(1).optional(),
    done: z.boolean()
  })
  .strict()
const vector = z
  .object({
    version: z.literal(1),
    queryHash: z.string().length(64),
    rosterHash: z.string().length(64),
    nextWorkspaceIndex: z.number().int().nonnegative(),
    workspaces: z.array(position).min(1)
  })
  .strict()
export type IssueListRecoveryVector = z.infer<typeof vector>

export function boundedListJson(value: unknown, maxBytes = LIST_CONTEXT_BYTES): string {
  try {
    return stringifyJsonWithinByteLimit(value, maxBytes).serialized
  } catch {
    throw linearError(
      'linear_list_metadata_capacity',
      'Linear list metadata exceeds capacity; restart with a concrete workspace.'
    )
  }
}

function hash(value: unknown): string {
  return createHash('sha256').update(boundedListJson(value)).digest('hex')
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical)
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)])
    )
  }
  return value
}

export function encodePageRecovery(state: IssueListRecoveryVector): string {
  const encoded = Buffer.from(boundedListJson(state)).toString('base64url')
  if (Buffer.byteLength(encoded) > LIST_CONTEXT_BYTES) {
    throw linearError(
      'linear_list_metadata_capacity',
      'Linear page recovery exceeds capacity; use concrete workspace recovery.'
    )
  }
  return encoded
}

export function createPageRecovery(
  request: LinearMcpIssueListRequest,
  workspaces: LinearWorkspace[]
): IssueListRecoveryVector {
  const queryHash = hash(
    canonical({
      filter: buildIssueFilter(request),
      orderBy: request.orderBy ?? 'updatedAt',
      includeArchived: request.includeArchived ?? false
    })
  )
  const roster: { id: string; credentialRevision: number }[] = []
  let rosterBytes = 2
  for (const { id, credentialRevision } of workspaces) {
    const entry = { id, credentialRevision: credentialRevision ?? 0 }
    rosterBytes += Buffer.byteLength(boundedListJson(entry)) + 1
    if (rosterBytes > LIST_CONTEXT_BYTES) {
      throw linearError(
        'linear_list_metadata_capacity',
        'Linear roster exceeds capacity; use a concrete workspace.'
      )
    }
    roster.push(entry)
  }
  roster.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const rosterHash = hash(roster)
  const initial: IssueListRecoveryVector = {
    version: 1,
    queryHash,
    rosterHash,
    nextWorkspaceIndex: 0,
    workspaces: roster.map((workspace) => ({ ...workspace, done: false }))
  }
  encodePageRecovery(initial)
  const encoded = request.pageRecovery?.continuation
  if (!encoded) {
    return initial
  }
  if (Buffer.byteLength(encoded) > LIST_CONTEXT_BYTES || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw linearError(
      'linear_list_stale_recovery',
      'Invalid Linear recovery; restart with a concrete workspace.'
    )
  }
  let parsed: IssueListRecoveryVector
  try {
    parsed = vector.parse(
      JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(encoded, 'base64url'))
      )
    )
  } catch {
    throw linearError(
      'linear_list_stale_recovery',
      'Invalid Linear recovery; restart with a concrete workspace.'
    )
  }
  if (
    parsed.queryHash !== queryHash ||
    parsed.rosterHash !== rosterHash ||
    parsed.nextWorkspaceIndex >= roster.length ||
    parsed.workspaces.length !== roster.length ||
    parsed.workspaces.some(
      (entry, index) =>
        entry.id !== roster[index].id ||
        entry.credentialRevision !== roster[index].credentialRevision ||
        (entry.after !== undefined && Buffer.byteLength(entry.after) > LIST_CURSOR_BYTES)
    )
  ) {
    throw linearError(
      'linear_list_stale_recovery',
      'Linear query or accounts changed; restart and reconcile by workspace and issue ID.'
    )
  }
  return parsed
}

export function decodeDeliveryPageRecovery(
  value: unknown
): { version: 1; continuation?: string } | undefined {
  if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1) {
    return undefined
  }
  if (!('continuation' in value) || value.continuation === undefined) {
    return { version: 1 }
  }
  const encoded = value.continuation
  if (
    typeof encoded !== 'string' ||
    Buffer.byteLength(encoded) > LIST_CONTEXT_BYTES ||
    !/^[A-Za-z0-9_-]+$/.test(encoded)
  ) {
    return undefined
  }
  try {
    const state = vector.parse(
      JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(encoded, 'base64url'))
      )
    )
    if (state.workspaces.some((w) => w.after && Buffer.byteLength(w.after) > LIST_CURSOR_BYTES)) {
      return undefined
    }
    return { version: 1, continuation: encodePageRecovery(state) }
  } catch {
    return undefined
  }
}
