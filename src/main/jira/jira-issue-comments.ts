import { requireStrictJiraSite } from './jira-read-failure'
import type { JiraComment } from '../../shared/jira/jira-types'
import {
  JIRA_IMAGE_MAX_BYTES,
  JIRA_IMAGE_MAX_REFERENCES,
  type JiraMediaFormat
} from '../../shared/jira/jira-attachment-image'
import { acquire, release } from './request-queue'
import { apiBasePath, jiraRequest, type JiraClientForSite } from './authenticated-request'
import { clearToken, getClients, isAuthError } from './client'
import {
  adfToMarkdownText,
  collectAdfMediaAttrs,
  type AdfToMarkdownOptions,
  type JiraAdfMediaAttrs
} from './adf-markdown'
import {
  extractAttachmentContentIdsFromHtml,
  selectPreferredAttachmentIds
} from './attachments/discovery'
import { mapUser } from './jira-issue-mapping'
import {
  flushMediaResolutionWarn,
  prepareMediaResolver,
  type MediaRequest
} from './jira-issue-media'
import { asRecord, asString, fetchPagedRecords, type JiraRecord } from './jira-record-pages'

function mapComment(raw: JiraRecord, adfOptions?: AdfToMarkdownOptions): JiraComment {
  return {
    id: asString(raw.id),
    body: adfToMarkdownText(raw.body, adfOptions),
    createdAt: asString(raw.created, new Date().toISOString()),
    updatedAt: asString(raw.updated) || undefined,
    user: mapUser(raw.author)
  }
}

/** Keep metadata JSON under the semaphore; Server/DC wiki !filename! media remains unsupported. */
async function collectCommentMediaRequest(
  client: JiraClientForSite,
  key: string,
  comments: JiraRecord[],
  mediaFormat?: JiraMediaFormat
): Promise<MediaRequest | undefined> {
  const htmlIds: string[] = []
  const seen = new Set<string>()
  const mediaAttrs: JiraAdfMediaAttrs[] = []
  for (const comment of comments) {
    for (const id of extractAttachmentContentIdsFromHtml(asString(comment.renderedBody))) {
      if (!seen.has(id)) {
        seen.add(id)
        htmlIds.push(id)
      }
    }
    mediaAttrs.push(...collectAdfMediaAttrs(comment.body))
  }

  const needingCount = mediaAttrs.filter(
    (attrs) => !(attrs.url && /^https?:\/\//i.test(attrs.url))
  ).length
  // HTML IDs alone cannot produce downloads; skip metadata without attachment-needing media.
  if (needingCount === 0) {
    return undefined
  }

  // Comment media shares issue attachments; use the site's API version for Server/DC.
  let attachmentField: unknown
  try {
    const issue = await jiraRequest<JiraRecord>(
      client,
      `${apiBasePath(client.site)}/issue/${encodeURIComponent(key)}?fields=attachment`
    )
    attachmentField = asRecord(issue.fields).attachment
  } catch (error) {
    console.warn('[jira] comment attachment lookup failed:', error)
    return undefined
  }

  const selection = selectPreferredAttachmentIds({
    renderedHtmlIds: htmlIds,
    attachmentField,
    mediaAttrs,
    ...(mediaFormat ? { maxBytes: JIRA_IMAGE_MAX_BYTES, maxImages: JIRA_IMAGE_MAX_REFERENCES } : {})
  })
  if (selection.needCount === 0 && selection.preferredIds.length === 0) {
    return undefined
  }
  return {
    attachmentField,
    preferredIds: selection.preferredIds,
    needCount: selection.needCount,
    fallbackRan: selection.fallbackRan,
    issueKey: key
  }
}

export async function getIssueComments(
  key: string,
  siteId?: string | null,
  strict = false,
  mediaFormat?: JiraMediaFormat
): Promise<JiraComment[]> {
  const entries = getClients(siteId)
  requireStrictJiraSite(entries, siteId, strict)
  const entry = entries[0]
  if (!entry) {
    return []
  }

  let comments: JiraRecord[] = []
  let mediaRequest: MediaRequest | undefined
  let held = false
  try {
    await acquire()
    held = true
    comments = await fetchPagedRecords(entry, 'comments', (startAt, maxResults) => {
      const params = new URLSearchParams({
        maxResults: String(maxResults),
        orderBy: 'created',
        startAt: String(startAt),
        expand: 'renderedBody'
      })
      return `${apiBasePath(entry.site)}/issue/${encodeURIComponent(key)}/comment?${params.toString()}`
    })
    mediaRequest = await collectCommentMediaRequest(entry, key, comments, mediaFormat)
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.site.id)
      throw error
    }
    console.warn('[jira] getIssueComments failed:', error)
    if (strict) {
      throw error
    }
    return []
  } finally {
    if (held) {
      held = false
      release()
    }
  }

  try {
    const prepared = mediaRequest
      ? await prepareMediaResolver(entry, mediaRequest, mediaFormat)
      : undefined
    const mapped = comments.map((comment) => mapComment(comment, prepared?.options))
    if (prepared) {
      flushMediaResolutionWarn(entry, prepared)
    }
    return mapped
  } catch (error) {
    console.warn('[jira] getIssueComments media load failed:', error)
    return comments.map((comment) => mapComment(comment))
  }
}
