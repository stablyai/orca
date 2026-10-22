import { randomUUID } from 'node:crypto'
import { JIRA_IMAGE_SCHEME } from '../../../shared/jira-attachment-image'
import { attachmentImagesEpoch } from './image-cache'
import type { JiraClientForSite } from '../authenticated-request'
import type { AttachmentMeta } from './meta'

const GRANT_TTL_MS = 30 * 60_000
const MAX_GRANTS = 2048
type ImageGrant = { siteId: string; meta: AttachmentMeta; epoch: number; expiresAt: number }
const grants = new Map<string, ImageGrant>()
const references = new Map<string, string>()

function revokeExpired(): void {
  for (const [reference, grant] of grants) {
    if (grant.expiresAt <= Date.now() || grant.epoch !== attachmentImagesEpoch(grant.siteId)) {
      grants.delete(reference)
      references.delete(`${grant.siteId}::${grant.meta.id}`)
    }
  }
}

export function registerAttachmentImageGrant(
  client: JiraClientForSite,
  meta: AttachmentMeta
): string {
  revokeExpired()
  const identity = `${client.site.id}::${meta.id}`
  const existing = references.get(identity)
  if (existing) {
    const grant = grants.get(existing)
    if (grant) {
      grant.meta = meta
      grant.expiresAt = Date.now() + GRANT_TTL_MS
      return `${JIRA_IMAGE_SCHEME}://attachment/${existing}`
    }
  }
  while (grants.size >= MAX_GRANTS) {
    const oldest = grants.keys().next().value
    if (!oldest) {
      break
    }
    const grant = grants.get(oldest)
    grants.delete(oldest)
    if (grant) {
      references.delete(`${grant.siteId}::${grant.meta.id}`)
    }
  }
  const reference = randomUUID()
  grants.set(reference, {
    siteId: client.site.id,
    meta,
    epoch: attachmentImagesEpoch(client.site.id),
    expiresAt: Date.now() + GRANT_TTL_MS
  })
  references.set(identity, reference)
  return `${JIRA_IMAGE_SCHEME}://attachment/${reference}`
}

export function attachmentImageGrant(reference: string): ImageGrant | null {
  revokeExpired()
  return grants.get(reference) ?? null
}

export function isAttachmentImageGrantCurrent(reference: string, grant: ImageGrant): boolean {
  return attachmentImageGrant(reference) === grant
}

export function resetAttachmentImageGrantsForTest(): void {
  grants.clear()
  references.clear()
}
