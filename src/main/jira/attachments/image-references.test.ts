import { expect, it, vi } from 'vitest'
import { loadIssueImageAttachments } from './images'
import { _resetAttachmentImageCache } from './image-cache'
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
