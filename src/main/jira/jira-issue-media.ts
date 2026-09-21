import { collectAdfMediaAttrs, type AdfToMarkdownOptions } from './adf-markdown'
import {
  extractAttachmentContentIdsFromHtml,
  selectPreferredAttachmentIds,
  warnIfMediaResolutionIncomplete
} from './attachment-discovery'
import {
  createMediaMarkdownResolver,
  loadIssueImageAttachments,
  type MediaResolutionStats
} from './attachment-images'
import type { JiraClientForSite } from './authenticated-request'
import { asRecord, asString, type JiraRecord } from './jira-record-pages'

export type MediaRequest = {
  attachmentField: unknown
  preferredIds: string[]
  needCount: number
  fallbackRan: boolean
  issueKey: string
}

/** Pooled: HTML/ADF selection only — no binary downloads. */
export function collectIssueMediaRequest(raw: JiraRecord): MediaRequest | undefined {
  const fields = asRecord(raw.fields)
  const renderedFields = asRecord(raw.renderedFields)
  const htmlIds = extractAttachmentContentIdsFromHtml(
    asString(renderedFields.description) || undefined
  )
  const mediaAttrs = collectAdfMediaAttrs(fields.description)
  const selection = selectPreferredAttachmentIds({
    renderedHtmlIds: htmlIds,
    attachmentField: fields.attachment,
    mediaAttrs
  })
  if (selection.needCount === 0 && selection.preferredIds.length === 0) {
    return undefined
  }
  return {
    attachmentField: fields.attachment,
    preferredIds: selection.preferredIds,
    needCount: selection.needCount,
    fallbackRan: selection.fallbackRan,
    issueKey: asString(raw.key)
  }
}

export type PreparedMedia = {
  options: AdfToMarkdownOptions
  stats: MediaResolutionStats
  request: MediaRequest
}

/** Unpooled: binary downloads + resolver (outside the Jira API semaphore). */
export async function prepareMediaResolver(
  client: JiraClientForSite,
  request: MediaRequest
): Promise<PreparedMedia | undefined> {
  if (request.preferredIds.length === 0) {
    warnIfMediaResolutionIncomplete({
      siteId: client.site.id,
      issueKey: request.issueKey,
      needCount: request.needCount,
      preferredIdCount: 0,
      resolvedCount: 0,
      fallbackRan: request.fallbackRan
    })
    return undefined
  }
  const images = await loadIssueImageAttachments(
    client,
    request.attachmentField,
    request.preferredIds
  )
  if (images.length === 0) {
    warnIfMediaResolutionIncomplete({
      siteId: client.site.id,
      issueKey: request.issueKey,
      needCount: request.needCount,
      preferredIdCount: request.preferredIds.length,
      resolvedCount: 0,
      fallbackRan: request.fallbackRan
    })
    return undefined
  }
  const stats: MediaResolutionStats = { attachmentResolvedCount: 0 }
  const resolveMedia = createMediaMarkdownResolver(images, request.preferredIds, stats)
  return {
    options: { resolveMedia },
    stats,
    request
  }
}

export function flushMediaResolutionWarn(client: JiraClientForSite, prepared: PreparedMedia): void {
  warnIfMediaResolutionIncomplete({
    siteId: client.site.id,
    issueKey: prepared.request.issueKey,
    needCount: prepared.request.needCount,
    preferredIdCount: prepared.request.preferredIds.length,
    resolvedCount: prepared.stats.attachmentResolvedCount,
    fallbackRan: prepared.request.fallbackRan
  })
}
