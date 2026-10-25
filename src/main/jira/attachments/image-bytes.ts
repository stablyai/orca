import { jiraRequestBinary, type JiraClientForSite } from '../authenticated-request'
import type { AttachmentMeta } from './meta'
import { attachmentContentUrl } from './content-url'
import {
  loadAttachmentBytesWithCache,
  type AttachmentImageBytes,
  attachmentImagesEpoch,
  getCachedAttachmentBytes
} from './image-cache'
import {
  JIRA_IMAGE_MAX_BYTES,
  JIRA_IMAGE_MAX_PENDING_READS,
  isJiraImageMimeType
} from '../../../shared/jira/jira-attachment-image'
import { withJiraDeadline } from '../jira-read-failure'
import { PrioritySemaphore } from '../../../shared/priority-semaphore'
import { waitForPromiseWithSignal } from '../../../shared/abort-signal-reason'

const downloads = new PrioritySemaphore(3)
const interests = new Map<string, { controller: AbortController; readers: number }>()

export async function readAttachmentImageBytes(
  client: JiraClientForSite,
  meta: AttachmentMeta,
  signal?: AbortSignal
): Promise<AttachmentImageBytes | null> {
  if (signal?.aborted) {
    throw signal.reason ?? new Error('Jira image request cancelled')
  }
  const cached = getCachedAttachmentBytes(client.site.id, meta.id)
  if (cached) {
    return cached
  }
  const key = `${client.site.id}::${attachmentImagesEpoch(client.site.id)}::${meta.id}`
  let interest = interests.get(key)
  if (!interest || interest.controller.signal.aborted) {
    if (interests.size >= JIRA_IMAGE_MAX_PENDING_READS) {
      throw new Error('Jira image queue is full.')
    }
    interest = { controller: new AbortController(), readers: 0 }
    interests.set(key, interest)
  }
  const owned = interest
  owned.readers += 1
  try {
    return await waitForPromiseWithSignal(
      loadAttachmentBytesWithCache({
        siteId: client.site.id,
        attachmentId: meta.id,
        signal: owned.controller.signal,
        load: async () => {
          const release = await downloads.acquire(0, owned.controller.signal)
          try {
            const url = attachmentContentUrl(client.site, meta)
            if (!url) {
              return null
            }
            const binary = await withJiraDeadline(owned.controller.signal, 30_000, (deadline) =>
              waitForPromiseWithSignal(
                jiraRequestBinary(client, url.toString(), {
                  maxBytes: JIRA_IMAGE_MAX_BYTES,
                  signal: deadline
                }),
                deadline
              )
            )
            const reported = binary.contentType.split(';')[0]?.trim().toLowerCase()
            const mimeType =
              !reported || reported === 'application/octet-stream'
                ? meta.mimeType.toLowerCase()
                : reported
            if (!isJiraImageMimeType(mimeType) || binary.data.byteLength === 0) {
              return null
            }
            return { data: new Uint8Array(binary.data), mimeType }
          } finally {
            release()
          }
        }
      }),
      signal
    )
  } finally {
    owned.readers -= 1
    if (owned.readers === 0) {
      owned.controller.abort()
      if (interests.get(key) === owned) {
        interests.delete(key)
      }
    }
  }
}
