import { beforeEach, describe, expect, it, vi } from 'vitest'
import { JIRA_IMAGE_MAX_BYTES } from '../../../shared/jira-attachment-image'
import { loadIssueImageAttachments, createMediaMarkdownResolver } from './images'
import { attachmentImageGrant, resetAttachmentImageGrantsForTest } from './image-grants'
import { clearAttachmentImagesForSite, _resetAttachmentImageCache } from './image-cache'
import type { JiraClientForSite } from '../authenticated-request'

const { JiraApiError: JiraApiErrorMock } = vi.hoisted(() => ({
  JiraApiError: class extends Error {}
}))

vi.mock('../jira-api-error', () => ({ JiraApiError: JiraApiErrorMock }))

vi.mock('../authenticated-request', () => ({
  apiBasePath: () => '/rest/api/3',
  jiraRequestBinary: vi.fn(),
  JiraApiError: JiraApiErrorMock
}))
const client: JiraClientForSite = {
  site: {
    id: 'site-1',
    siteUrl: 'https://example.atlassian.net',
    email: '',
    accountId: '',
    displayName: ''
  },
  authorization: 'secret'
}
const metadata = [
  {
    id: '1',
    filename: 'shot.png',
    mimeType: 'image/png',
    size: 3 * 1024 * 1024,
    content: 'https://example.atlassian.net/secure/attachment/1/shot.png'
  }
]

describe('lazy Jira image references', () => {
  beforeEach(() => {
    _resetAttachmentImageCache()
    resetAttachmentImageGrantsForTest()
    vi.clearAllMocks()
  })
  it('keeps image bytes out of Markdown without downloading the attachment', async () => {
    const { jiraRequestBinary } = await import('../authenticated-request')
    const images = await loadIssueImageAttachments(client, metadata, ['1'], 'reference')
    const markdown = createMediaMarkdownResolver(images, ['1'])({ id: 'media-id', alt: 'shot.png' })
    expect(markdown).toMatch(/^!\[shot.png\]\(orca-jira-image:\/\/attachment\/[0-9a-f-]+\)$/)
    expect(markdown).not.toContain('data:')
    expect(jiraRequestBinary).not.toHaveBeenCalled()
  })
  it('keeps grants isolated by site and revokes them on disconnect', async () => {
    const images = await loadIssueImageAttachments(client, metadata, ['1'], 'reference')
    const reference = images[0]?.dataUrl.split('/').at(-1) ?? ''
    expect(attachmentImageGrant(reference)?.siteId).toBe('site-1')
    clearAttachmentImagesForSite('other-site')
    expect(attachmentImageGrant(reference)).not.toBeNull()
    clearAttachmentImagesForSite('site-1')
    expect(attachmentImageGrant(reference)).toBeNull()
  })
  it('retains per-image limits while removing the legacy aggregate-byte cap', async () => {
    const entries = [1, 2, 3].map((id) => ({ ...metadata[0], id: String(id) }))
    expect(
      await loadIssueImageAttachments(client, entries, ['1', '2', '3'], 'reference')
    ).toHaveLength(3)
    const oversized = [{ ...metadata[0], size: JIRA_IMAGE_MAX_BYTES + 1 }]
    expect(await loadIssueImageAttachments(client, oversized, ['1'], 'reference')).toEqual([])
  })
})

it('discovers larger images by filename when rendered HTML has no attachment IDs', async () => {
  const { collectIssueMediaRequest } = await import('../jira-issue-media')
  const raw = {
    key: 'JIRA-1',
    fields: {
      attachment: metadata,
      description: {
        type: 'doc',
        content: [
          {
            type: 'mediaSingle',
            content: [{ type: 'media', attrs: { id: 'media-id', alt: 'shot.png' } }]
          }
        ]
      }
    }
  }
  expect(collectIssueMediaRequest(raw)?.preferredIds).toEqual([])
  expect(collectIssueMediaRequest(raw, 'reference')?.preferredIds).toEqual(['1'])
})

it('keeps the old per-image cap when an old client reuses a newer byte-cache entry', async () => {
  const { loadAttachmentBytesWithCache } = await import('./image-cache')
  _resetAttachmentImageCache()
  await loadAttachmentBytesWithCache({
    siteId: client.site.id,
    attachmentId: '1',
    load: async () => ({ data: new Uint8Array(3 * 1024 * 1024), mimeType: 'image/png' })
  })
  expect(await loadIssueImageAttachments(client, [{ ...metadata[0], size: 0 }], ['1'])).toEqual([])
})
