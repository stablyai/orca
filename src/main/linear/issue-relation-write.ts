import { LinearClient } from '@linear/sdk'
import type {
  LinearIssueRelationship,
  LinearIssueRelationWriteResult
} from '../../shared/linear-issue-relation-write'
import { LINEAR_ISSUE_API_PAGE_SIZE_MAX } from '../../shared/linear-issue-read-limits'
import { acquire, clearToken, getClients, isAuthError, release } from './client'
import { linearError } from './issue-context-errors'
import {
  INVERSE_RELATIONS_QUERY,
  RELATIONS_QUERY,
  type RawRelationNode,
  type RawRelationsResponse
} from './issue-context-raw'
import { createLinearIssueRelation, deleteLinearIssueRelation } from './issue-relation-mutation'
import { LinearWriteFailure } from './issues'

const RELATION_WRITE_READ_CAP = 250

type RelationDirection = 'outbound' | 'inbound'

export async function writeIssueRelation(params: {
  issue: LinearIssueRelationWriteResult['issue']
  relatedIssue: LinearIssueRelationWriteResult['relatedIssue']
  relationship: LinearIssueRelationship
  operation: 'add' | 'remove'
  workspaceId: string
  signal?: AbortSignal
}): Promise<LinearIssueRelationWriteResult> {
  const entry = getClients(params.workspaceId)[0]
  if (!entry) {
    throw new LinearWriteFailure('failed', 'Not connected to Linear')
  }
  await acquire()
  try {
    const client = params.signal
      ? new LinearClient({ apiKey: entry.apiKey, signal: params.signal })
      : entry.client
    const existing = await findExistingRelation(client, params)
    if (params.operation === 'add' && existing) {
      return result(params, existing, true)
    }
    if (params.operation === 'remove' && !existing) {
      return result(params, absentRelation(params), true)
    }
    if (params.operation === 'remove' && existing) {
      await deleteLinearIssueRelation(client, existing.id)
      return result(params, existing, false)
    }
    const created = await createLinearIssueRelation(client, relationCreateInput(params))
    return result(params, normalizeRelation(created, params.issue.id), false)
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.workspace.id)
    }
    throw error
  } finally {
    release()
  }
}

async function findExistingRelation(
  client: LinearClient,
  params: {
    issue: { id: string; identifier: string }
    relatedIssue: { id: string }
    relationship: LinearIssueRelationship
  }
): Promise<LinearIssueRelationWriteResult['relation'] | null> {
  for (const direction of relationDirections(params.relationship)) {
    const scan = await findRelationInDirection(client, params, direction)
    if (scan.relation) {
      return scan.relation
    }
    if (scan.hasMore) {
      throw linearError(
        'linear_write_failed',
        `Cannot safely modify ${params.issue.identifier}: more than ${RELATION_WRITE_READ_CAP} relevant relations must be checked.`,
        {
          cap: RELATION_WRITE_READ_CAP,
          nextSteps: [
            `Remove stale relations from ${params.issue.identifier} in Linear, then retry.`
          ]
        }
      )
    }
  }
  return null
}

async function findRelationInDirection(
  client: LinearClient,
  params: {
    issue: { id: string }
    relatedIssue: { id: string }
    relationship: LinearIssueRelationship
  },
  direction: RelationDirection
): Promise<{ relation: LinearIssueRelationWriteResult['relation'] | null; hasMore: boolean }> {
  let after: string | undefined
  let inspected = 0

  while (inspected < RELATION_WRITE_READ_CAP) {
    const first = Math.min(LINEAR_ISSUE_API_PAGE_SIZE_MAX, RELATION_WRITE_READ_CAP - inspected)
    const raw = await client.client.rawRequest<RawRelationsResponse, Record<string, unknown>>(
      direction === 'outbound' ? RELATIONS_QUERY : INVERSE_RELATIONS_QUERY,
      { id: params.issue.id, first, ...(after ? { after } : {}) }
    )
    const connection =
      direction === 'outbound' ? raw.data?.issue?.relations : raw.data?.issue?.inverseRelations
    const nodes = (connection?.nodes ?? []).slice(0, first)
    const relation = nodes
      .map((node) => normalizeRelation(node, params.issue.id, direction))
      .find(
        (candidate) =>
          candidate.relationship === params.relationship &&
          candidate.relatedIssue?.id === params.relatedIssue.id
      )
    if (relation) {
      return { relation, hasMore: false }
    }

    inspected += nodes.length
    const hasMore = connection?.pageInfo?.hasNextPage === true
    const nextCursor = connection?.pageInfo?.endCursor ?? undefined
    if (!hasMore) {
      return { relation: null, hasMore: false }
    }
    if (!nextCursor || nextCursor === after || nodes.length === 0) {
      return { relation: null, hasMore: true }
    }
    after = nextCursor
  }

  return { relation: null, hasMore: true }
}

function relationDirections(relationship: LinearIssueRelationship): RelationDirection[] {
  if (relationship === 'blockedBy') {
    return ['inbound']
  }
  if (relationship === 'relatedTo') {
    return ['outbound', 'inbound']
  }
  return ['outbound']
}

function normalizeRelation(
  node: RawRelationNode,
  issueId: string,
  knownDirection?: RelationDirection
): LinearIssueRelationWriteResult['relation'] {
  const outbound = knownDirection
    ? knownDirection === 'outbound'
    : node.issue?.id === issueId || node.relatedIssue?.id !== issueId
  const neighbor = outbound ? node.relatedIssue : node.issue
  const type = node.type ?? null
  return {
    id: node.id,
    type,
    direction: outbound ? 'outbound' : 'inbound',
    relationship: relationPerspective(type, outbound),
    relatedIssue: neighbor
      ? {
          id: neighbor.id,
          identifier: neighbor.identifier,
          title: neighbor.title,
          url: neighbor.url
        }
      : null
  }
}

function relationPerspective(
  type: string | null,
  outbound: boolean
): LinearIssueRelationWriteResult['relation']['relationship'] {
  if (type === 'blocks') {
    return outbound ? 'blocks' : 'blockedBy'
  }
  if (type === 'duplicate') {
    return outbound ? 'duplicateOf' : 'duplicatedBy'
  }
  if (type === 'similar') {
    return 'similar'
  }
  return 'relatedTo'
}

function relationCreateInput(params: {
  issue: { id: string }
  relatedIssue: { id: string }
  relationship: LinearIssueRelationship
}): { issueId: string; relatedIssueId: string; type: string } {
  if (params.relationship === 'blockedBy') {
    return {
      issueId: params.relatedIssue.id,
      relatedIssueId: params.issue.id,
      type: 'blocks'
    }
  }
  return {
    issueId: params.issue.id,
    relatedIssueId: params.relatedIssue.id,
    type:
      params.relationship === 'relatedTo'
        ? 'related'
        : params.relationship === 'duplicateOf'
          ? 'duplicate'
          : 'blocks'
  }
}

function absentRelation(params: {
  relatedIssue: LinearIssueRelationWriteResult['relatedIssue']
  relationship: LinearIssueRelationship
}): LinearIssueRelationWriteResult['relation'] {
  return {
    id: '',
    type: linearRelationType(params.relationship),
    direction: params.relationship === 'blockedBy' ? 'inbound' : 'outbound',
    relationship: params.relationship,
    relatedIssue: params.relatedIssue
  }
}

function linearRelationType(relationship: LinearIssueRelationship): string {
  if (relationship === 'relatedTo') {
    return 'related'
  }
  if (relationship === 'duplicateOf') {
    return 'duplicate'
  }
  return 'blocks'
}

function result(
  params: {
    issue: LinearIssueRelationWriteResult['issue']
    relatedIssue: LinearIssueRelationWriteResult['relatedIssue']
    operation: 'add' | 'remove'
    workspaceId: string
  },
  relation: LinearIssueRelationWriteResult['relation'],
  alreadySet: boolean
): LinearIssueRelationWriteResult {
  return {
    issue: params.issue,
    relatedIssue: params.relatedIssue,
    relation,
    operation: params.operation,
    meta: { workspaceId: params.workspaceId, alreadySet }
  }
}
