import type {
  LinearCollectionMeta,
  LinearIssueAttachment,
  LinearIssueChildNode,
  LinearIssueCommentNode,
  LinearIssueContextResult,
  LinearIssueInclude,
  LinearIssueRelation,
  LinearIssueRequest
} from '../../shared/linear-agent-access'
import {
  LINEAR_ATTACHMENTS_CAP,
  LINEAR_CHILDREN_NODE_CAP,
  LINEAR_COMMENTS_CAP,
  LINEAR_COMMENT_BODY_CAP,
  LINEAR_RELATIONS_CAP,
  clampLinearIssueDepth
} from '../../shared/linear-agent-access'
import { extractLinearInlineMedia } from '../../shared/linear-inline-media'
import type { ResolvedIssue } from './issue-context-client'
import { getRequiredEntry, withLinearRead } from './issue-context-client'
import { getPublicFileUrlClient } from './client'
import { includeErrorCode } from './issue-context-errors'
import { readConnectionPages } from './issue-context-pagination'
import {
  ATTACHMENTS_QUERY,
  CHILDREN_QUERY,
  COMMENTS_QUERY,
  RELATIONS_QUERY,
  collectionMeta,
  mapIssue,
  type RawAttachmentsResponse,
  type RawChildrenResponse,
  type RawCommentsResponse,
  type RawRelationsResponse
} from './issue-context-raw'

export async function readOptionalIncludes(
  resolved: ResolvedIssue,
  request: LinearIssueRequest,
  result: LinearIssueContextResult,
  includeErrors: LinearIssueContextResult['meta']['includeErrors'],
  sections: LinearIssueContextResult['meta']['sections']
): Promise<void> {
  const includeTasks: [LinearIssueInclude, () => Promise<void>][] = []
  if (request.include.comments) {
    includeTasks.push(['comments', async () => assignComments(resolved, result, sections)])
  }
  if (request.include.children) {
    includeTasks.push([
      'children',
      async () => assignChildren(resolved, request.depth, result, sections)
    ])
  }
  if (request.include.attachments) {
    includeTasks.push(['attachments', async () => assignAttachments(resolved, result, sections)])
  }
  if (request.include.relations) {
    includeTasks.push(['relations', async () => assignRelations(resolved, result, sections)])
  }

  for (const [include, task] of includeTasks) {
    try {
      await task()
    } catch (error) {
      includeErrors.push({
        include,
        code: includeErrorCode(error),
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }
}

async function assignComments(
  resolved: ResolvedIssue,
  result: LinearIssueContextResult,
  sections: LinearIssueContextResult['meta']['sections']
): Promise<void> {
  const read = await readComments(resolved)
  result.comments = read.items
  sections.comments = read.meta
}

async function assignChildren(
  resolved: ResolvedIssue,
  depth: number,
  result: LinearIssueContextResult,
  sections: LinearIssueContextResult['meta']['sections']
): Promise<void> {
  const read = await readChildren(resolved, clampLinearIssueDepth(depth))
  result.children = read.items
  sections.children = read.meta
}

async function assignAttachments(
  resolved: ResolvedIssue,
  result: LinearIssueContextResult,
  sections: LinearIssueContextResult['meta']['sections']
): Promise<void> {
  const read = await readAttachments(resolved)
  result.attachments = read.items
  sections.attachments = read.meta
}

async function assignRelations(
  resolved: ResolvedIssue,
  result: LinearIssueContextResult,
  sections: LinearIssueContextResult['meta']['sections']
): Promise<void> {
  const read = await readRelations(resolved)
  result.relations = read.items
  sections.relations = read.meta
}

async function readComments(resolved: ResolvedIssue): Promise<{
  items: LinearIssueCommentNode[]
  meta: LinearCollectionMeta
}> {
  const entry = getRequiredEntry(resolved.workspace.id)
  const response = await readConnectionPages(LINEAR_COMMENTS_CAP, async (page) => {
    return await withLinearRead(entry, async () => {
      const client = getPublicFileUrlClient(entry)
      const raw = await client.client.rawRequest<RawCommentsResponse, Record<string, unknown>>(
        COMMENTS_QUERY,
        { id: resolved.issue.id, ...page }
      )
      return raw.data?.issue?.comments ?? null
    })
  })
  const nodes = response.nodes
  const items = nodes.slice(0, LINEAR_COMMENTS_CAP).map((comment) => {
    const body = comment.body ?? ''
    // Extract media from the full body before truncating so screenshots past
    // the body cap are still surfaced.
    const inlineMedia = extractLinearInlineMedia(body, 'comment', comment.id)
    return {
      id: comment.id,
      body: body.slice(0, LINEAR_COMMENT_BODY_CAP),
      bodyTruncated: body.length > LINEAR_COMMENT_BODY_CAP,
      ...(inlineMedia.length > 0 ? { inlineMedia } : {}),
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
      parentId: comment.parent?.id ?? null,
      user: comment.user ?? null
    }
  })
  return {
    items,
    meta: collectionMeta(items.length, LINEAR_COMMENTS_CAP, response.hasMore)
  }
}

async function readChildren(
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

  const readLevel = async (issueId: string, level: number): Promise<LinearIssueChildNode[]> => {
    if (level > depth || returned >= LINEAR_CHILDREN_NODE_CAP) {
      depthReached = true
      return []
    }
    const remaining = LINEAR_CHILDREN_NODE_CAP - returned
    const response = await readConnectionPages(remaining, async (page) => {
      return await withLinearRead(entry, async () => {
        const client = getPublicFileUrlClient(entry)
        const raw = await client.client.rawRequest<RawChildrenResponse, Record<string, unknown>>(
          CHILDREN_QUERY,
          { id: issueId, ...page }
        )
        return raw.data?.issue?.children ?? null
      })
    })
    const nodes = response.nodes
    if (response.hasMore || nodes.length > remaining) {
      capReached = true
    }
    const children = nodes.slice(0, remaining).map((node) => {
      returned += 1
      return { raw: node, child: mapIssue(node) as LinearIssueChildNode }
    })
    if (returned >= LINEAR_CHILDREN_NODE_CAP) {
      capReached = true
    }

    // Why: when the current level already exhausts the output cap, fetching
    // grandchildren would add latency without returning any additional nodes.
    const canReadNested = level < depth && returned < LINEAR_CHILDREN_NODE_CAP
    if (!canReadNested && level >= depth && children.length > 0) {
      depthReached = true
    }
    const mappedChildren: LinearIssueChildNode[] = []
    for (const { raw, child } of children) {
      const nested = canReadNested ? await readLevel(raw.id, level + 1) : []
      if (nested.length > 0) {
        child.children = nested
      }
      child.mayHaveMore = level >= depth || returned >= LINEAR_CHILDREN_NODE_CAP || response.hasMore
      mappedChildren.push(child)
    }
    return mappedChildren
  }

  const items = await readLevel(resolved.issue.id, 1)
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

async function readAttachments(
  resolved: ResolvedIssue
): Promise<{ items: LinearIssueAttachment[]; meta: LinearCollectionMeta }> {
  const entry = getRequiredEntry(resolved.workspace.id)
  const response = await readConnectionPages(LINEAR_ATTACHMENTS_CAP, async (page) => {
    return await withLinearRead(entry, async () => {
      const raw = await entry.client.client.rawRequest<
        RawAttachmentsResponse,
        Record<string, unknown>
      >(ATTACHMENTS_QUERY, { id: resolved.issue.id, ...page })
      return raw.data?.issue?.attachments ?? null
    })
  })
  const items = response.nodes.slice(0, LINEAR_ATTACHMENTS_CAP).map((node) => ({
    id: node.id,
    title: node.title,
    url: node.url,
    source: node.source,
    subtitle: node.subtitle,
    createdAt: node.createdAt,
    metadataOnly: true as const
  }))
  return {
    items,
    meta: collectionMeta(items.length, LINEAR_ATTACHMENTS_CAP, response.hasMore)
  }
}

async function readRelations(
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
  const items = response.nodes.slice(0, LINEAR_RELATIONS_CAP).map((node) => ({
    id: node.id,
    type: node.type,
    relatedIssue: node.relatedIssue
      ? {
          id: node.relatedIssue.id,
          identifier: node.relatedIssue.identifier,
          title: node.relatedIssue.title,
          url: node.relatedIssue.url
        }
      : null
  }))
  return {
    items,
    meta: collectionMeta(items.length, LINEAR_RELATIONS_CAP, response.hasMore)
  }
}
