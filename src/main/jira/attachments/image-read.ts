import { getClients } from '../client'
import { attachmentImageGrant, isAttachmentImageGrantCurrent } from './image-grants'
import { readAttachmentImageBytes } from './image-bytes'
import type { AttachmentImageBytes } from './image-cache'

export async function readGrantedAttachmentImage(
  reference: string,
  signal?: AbortSignal
): Promise<AttachmentImageBytes | null> {
  const grant = attachmentImageGrant(reference)
  if (!grant) {
    return null
  }
  const client = getClients(grant.siteId).find((entry) => entry.site.id === grant.siteId)
  if (!client) {
    return null
  }
  const image = await readAttachmentImageBytes(client, grant.meta, signal)
  if (!isAttachmentImageGrantCurrent(reference, grant) || signal?.aborted) {
    return null
  }
  return image
}
