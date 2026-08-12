import type { LinearCollectionMeta, LinearIssueRelation } from '../../shared/linear-agent-access'
import { LINEAR_RELATIONS_CAP } from '../../shared/linear-agent-access'
import type { ResolvedIssue } from './issue-context-client'
import { getRequiredEntry, withLinearRead } from './issue-context-client'
import { readConnectionPages } from './issue-context-pagination'
import {
  INVERSE_RELATIONS_QUERY,
  RELATIONS_QUERY,
  collectionMeta,
  type RawIssue,
  type RawRelationNode,
  type RawRelationsResponse
} from './issue-context-raw'

export async function readIssueRelations(
  resolved: ResolvedIssue
): Promise<{ items: LinearIssueRelation[]; meta: LinearCollectionMeta }> {
  const entry = getRequiredEntry(resolved.workspace.id)
  const response = await readConnectionPages(LINEAR_RELATIONS_CAP, async (page) => {
    return await withLinearRead(entry, async () => {
      const raw = await entry.client.client.rawRequest<
        RawRelationsResponse,
        Record<string, unknown>
      >(RELATIONS_QUERY, { id: resolved.issue.id, ...page })
      return raw.data?.issue?.relations ?? null
    })
  })
  const outbound = response.nodes
    .slice(0, LINEAR_RELATIONS_CAP)
    .map((node) => mapRelation(node, 'outbound', node.relatedIssue))
  const remaining = LINEAR_RELATIONS_CAP - outbound.length
  // Why: when outbound relations exactly fill the cap, probe inverse relations so
  // the response cannot claim completeness while silently omitting inbound ones.
  const inverseReadLimit = Math.max(1, remaining)
  const inverse = await readConnectionPages(inverseReadLimit, async (page) => {
    return await withLinearRead(entry, async () => {
      const raw = await entry.client.client.rawRequest<
        RawRelationsResponse,
        Record<string, unknown>
      >(INVERSE_RELATIONS_QUERY, { id: resolved.issue.id, ...page })
      return raw.data?.issue?.inverseRelations ?? null
    })
  })
  const inbound = inverse.nodes
    .slice(0, remaining)
    .map((node) => mapRelation(node, 'inbound', node.issue))
  const items = [...outbound, ...inbound]
  const inverseOverflow = inverse.nodes.length > remaining
  return {
    items,
    meta: collectionMeta(
      items.length,
      LINEAR_RELATIONS_CAP,
      response.hasMore || inverse.hasMore || inverseOverflow
    )
  }
}

function mapRelation(
  node: RawRelationNode,
  direction: LinearIssueRelation['direction'],
  relatedIssue: RawIssue | null | undefined
): LinearIssueRelation {
  const type = node.type ?? null
  return {
    id: node.id,
    type,
    direction,
    relationship: relationPerspective(type, direction),
    relatedIssue: relatedIssue
      ? {
          id: relatedIssue.id,
          identifier: relatedIssue.identifier,
          title: relatedIssue.title,
          url: relatedIssue.url
        }
      : null
  }
}

function relationPerspective(
  type: string | null,
  direction: LinearIssueRelation['direction']
): LinearIssueRelation['relationship'] {
  if (type === 'blocks') {
    return direction === 'outbound' ? 'blocks' : 'blockedBy'
  }
  if (type === 'duplicate') {
    return direction === 'outbound' ? 'duplicateOf' : 'duplicatedBy'
  }
  if (type === 'similar') {
    return 'similar'
  }
  return 'relatedTo'
}
