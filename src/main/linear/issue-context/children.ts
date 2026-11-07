import type {
  LinearCollectionMeta,
  LinearIssueChildNode
} from '../../../shared/linear/agent-result-types'
import { LINEAR_CHILDREN_NODE_CAP } from '../../../shared/linear/agent-access'
import { getPublicFileUrlClient } from '../client'
import { getRequiredEntry, withLinearRead, type ResolvedIssue } from './client'
import { readConnectionPages } from './pagination'
import {
  CHILDREN_QUERY,
  childrenPageSize,
  collectionMeta,
  mapIssue,
  type RawChildrenConnection,
  type RawChildrenResponse
} from './raw'

export async function readChildren(
  resolved: ResolvedIssue,
  depth: number
): Promise<{ items: LinearIssueChildNode[]; meta: LinearCollectionMeta }> {
  if (depth <= 0) {
    return { items: [], meta: collectionMeta(0, LINEAR_CHILDREN_NODE_CAP, false) }
  }
  const entry = getRequiredEntry(resolved.workspace.id)
  let returned = 0
  let capReached = false
  let depthReached = false

  const visitConnection = async (
    issueId: string,
    level: number,
    initial?: RawChildrenConnection | null
  ): Promise<LinearIssueChildNode[]> => {
    if (level > depth || returned >= LINEAR_CHILDREN_NODE_CAP) {
      depthReached = true
      return []
    }
    const remaining = LINEAR_CHILDREN_NODE_CAP - returned
    const remainingDepth = depth - level + 1
    let prefetched = initial !== undefined
    const response = await readConnectionPages(
      remaining,
      async (page) => {
        if (prefetched) {
          prefetched = false
          return initial ?? null
        }
        return await withLinearRead(entry, async () => {
          const client = getPublicFileUrlClient(entry)
          const raw = await client.client.rawRequest<RawChildrenResponse, Record<string, unknown>>(
            CHILDREN_QUERY(remainingDepth),
            { id: issueId, ...page }
          )
          return raw.data?.issue?.children ?? null
        })
      },
      childrenPageSize(remainingDepth)
    )
    if (response.hasMore || response.nodes.length > remaining) {
      capReached = true
    }
    // Allocate all siblings before their descendants, preserving the existing output prefix.
    const children = response.nodes.slice(0, remaining).map((node) => {
      returned += 1
      const child: LinearIssueChildNode = mapIssue(node)
      return { raw: node, child }
    })
    if (returned >= LINEAR_CHILDREN_NODE_CAP) {
      capReached = true
    }

    const canReadNested = level < depth && returned < LINEAR_CHILDREN_NODE_CAP
    if (!canReadNested && level >= depth && children.length > 0) {
      depthReached = true
    }
    for (const { raw, child } of children) {
      const nested = canReadNested
        ? await visitConnection(raw.id, level + 1, raw.children ?? null)
        : []
      if (nested.length > 0) {
        child.children = nested
      }
      child.mayHaveMore = level >= depth || returned >= LINEAR_CHILDREN_NODE_CAP || response.hasMore
    }
    return children.map(({ child }) => child)
  }

  const items = await visitConnection(resolved.issue.id, 1)
  return {
    items,
    meta: {
      returned,
      cap: LINEAR_CHILDREN_NODE_CAP,
      capReached,
      mayHaveMore: capReached || depthReached
    }
  }
}
