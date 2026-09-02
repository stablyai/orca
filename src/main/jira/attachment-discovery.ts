import type { JiraAdfMediaAttrs } from './adf-markdown'
import { MAX_IMAGES, parseImageAttachmentMetas } from './attachment-meta'

/**
 * Pull attachment content IDs from Jira rendered HTML in document order.
 * Why: thumbnail paths use the same numeric attachment id as content URLs.
 */
export function extractAttachmentContentIdsFromHtml(html: string | undefined | null): string[] {
  if (!html) {
    return []
  }
  const ids: string[] = []
  const seen = new Set<string>()
  // content, secure/attachment, thumbnail, and rest thumbnail forms
  const pattern =
    /\/(?:rest\/api\/\d+\/attachment\/(?:content|thumbnail)|secure\/(?:attachment|thumbnail))\/(\d+)(?:\/|\b|"|'|\?)/gi
  let match: RegExpExecArray | null
  while ((match = pattern.exec(html)) !== null) {
    const id = match[1]
    if (!id || seen.has(id)) {
      continue
    }
    seen.add(id)
    ids.push(id)
  }
  return ids
}

/** Prefer attachment-needing media (no external https URL) for discovery fallback. */
export function selectPreferredAttachmentIds(args: {
  renderedHtmlIds: string[]
  attachmentField: unknown
  mediaAttrs: readonly JiraAdfMediaAttrs[]
}): { preferredIds: string[]; fallbackRan: boolean; needCount: number } {
  const needing = args.mediaAttrs.filter((attrs) => !(attrs.url && /^https?:\/\//i.test(attrs.url)))
  const needCount = needing.length
  if (needCount === 0) {
    // Why: no attachment-needing ADF media — skip downloads (do not sweep HTML-only).
    return { preferredIds: [], fallbackRan: false, needCount: 0 }
  }

  const preferredIds = [...args.renderedHtmlIds]
  const taken = new Set(preferredIds)
  let fallbackRan = false

  if (needCount > preferredIds.length) {
    const metas = parseImageAttachmentMetas(args.attachmentField)
    // Why: multiple Jira screenshots often share image.png — assign next unused meta per node.
    for (const node of needing) {
      if (preferredIds.length >= MAX_IMAGES) {
        break
      }
      const alt = (node.alt ?? '').trim()
      if (!alt) {
        continue
      }
      const altKey = alt.toLowerCase()
      const meta = metas.find(
        (candidate) => candidate.filename.toLowerCase() === altKey && !taken.has(candidate.id)
      )
      if (!meta) {
        continue
      }
      taken.add(meta.id)
      preferredIds.push(meta.id)
      fallbackRan = true
    }
  }

  return {
    preferredIds: preferredIds.slice(0, MAX_IMAGES),
    fallbackRan,
    needCount
  }
}

export function warnIfMediaResolutionIncomplete(args: {
  siteId: string
  issueKey: string
  needCount: number
  preferredIdCount: number
  resolvedCount: number
  fallbackRan: boolean
}): void {
  if (args.needCount <= 0) {
    return
  }
  if (args.resolvedCount >= args.needCount) {
    return
  }
  console.warn('[jira] inline image resolution incomplete', {
    siteId: args.siteId,
    issueKey: args.issueKey,
    needCount: args.needCount,
    preferredIdCount: args.preferredIdCount,
    resolvedCount: args.resolvedCount,
    fallbackRan: args.fallbackRan
  })
}
