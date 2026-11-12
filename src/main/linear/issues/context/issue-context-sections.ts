import type {
  LinearCollectionMeta,
  LinearIssueAttachment,
  LinearIssueCommentNode,
  LinearIssueContextResult
} from '../../../../shared/linear/agent-result-types'
import type { LinearIssueActivityEntry } from '../../../../shared/linear/issue-activity'
import type { LinearIssueInclude, LinearIssueRequest } from '../../../../shared/linear/agent-access'
import {
  LINEAR_ATTACHMENTS_CAP,
  LINEAR_ACTIVITY_CAP,
  LINEAR_COMMENTS_CAP,
  LINEAR_COMMENT_BODY_CAP,
  clampLinearIssueDepth
} from '../../../../shared/linear/agent-access'
import { extractLinearInlineMedia } from '../../../../shared/linear/inline-media'
import type { ResolvedIssue } from './issue-context-resolution'
import { getRequiredEntry, withLinearRead } from './issue-context-resolution'
import { getPublicFileUrlClient } from '../../accounts/linear-account-client'
import { includeErrorCode } from './linear-access-errors'
import { readConnectionPages } from './linear-connection-pages'
import { ACTIVITY_QUERY, mapActivity, type RawActivityResponse } from '../issue-activity-raw'
import { readIssueRelations } from './issue-context-relations'
import { readChildren } from './issue-context-children'
import {
  ATTACHMENTS_QUERY,
  COMMENTS_QUERY,
  collectionMeta,
  type RawAttachmentsResponse,
  type RawCommentsResponse
} from './issue-context-graphql'

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
  if (request.include.activity) {
    includeTasks.push(['activity', async () => assignActivity(resolved, result, sections)])
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
  const read = await readIssueRelations(resolved)
  result.relations = read.items
  sections.relations = read.meta
}

async function assignActivity(
  resolved: ResolvedIssue,
  result: LinearIssueContextResult,
  sections: LinearIssueContextResult['meta']['sections']
): Promise<void> {
  const read = await readActivity(resolved)
  result.activity = read.items
  sections.activity = read.meta
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
    // Extract media before truncation so images beyond the body cap remain available.
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
async function readActivity(
  resolved: ResolvedIssue
): Promise<{ items: LinearIssueActivityEntry[]; meta: LinearCollectionMeta }> {
  const entry = getRequiredEntry(resolved.workspace.id)
  const response = await readConnectionPages(LINEAR_ACTIVITY_CAP, async (page) => {
    return await withLinearRead(entry, async () => {
      const raw = await entry.client.client.rawRequest<
        RawActivityResponse,
        Record<string, unknown>
      >(ACTIVITY_QUERY, { id: resolved.issue.id, ...page })
      return raw.data?.issue?.history ?? null
    })
  })
  const items = response.nodes.slice(0, LINEAR_ACTIVITY_CAP).map(mapActivity)
  return {
    items,
    meta: collectionMeta(items.length, LINEAR_ACTIVITY_CAP, response.hasMore)
  }
}
