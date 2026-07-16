import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JiraClientForSite } from './client'

const { jiraRequestBinaryMock } = vi.hoisted(() => ({
  jiraRequestBinaryMock: vi.fn()
}))

vi.mock('./client', () => ({
  jiraRequestBinary: (...args: unknown[]) => jiraRequestBinaryMock(...args),
  JiraApiError: class JiraApiError extends Error {
    status: number | null
    constructor(message: string, status: number | null = null) {
      super(message)
      this.status = status
    }
  }
}))

function makeEntry(): JiraClientForSite {
  return {
    site: {
      id: 'site-1',
      siteUrl: 'https://example.atlassian.net',
      email: 'ada@example.com',
      displayName: 'Example Jira',
      accountId: 'account-1'
    },
    authorization: 'Basic token'
  }
}

describe('attachment image helpers', () => {
  beforeEach(() => {
    jiraRequestBinaryMock.mockReset()
  })

  it('extracts attachment content ids from rendered HTML in order', async () => {
    const { extractAttachmentContentIdsFromHtml } = await import('./attachment-images')
    const ids = extractAttachmentContentIdsFromHtml(`
      <p>intro</p>
      <img src="https://example.atlassian.net/rest/api/3/attachment/content/101" />
      <img src="https://example.atlassian.net/secure/attachment/202/shot.png" />
      <img src="https://example.atlassian.net/rest/api/3/attachment/content/101" />
    `)
    expect(ids).toEqual(['101', '202'])
  })

  it('downloads image attachments and builds a media resolver', async () => {
    const pngBytes = Uint8Array.from([137, 80, 78, 71])
    jiraRequestBinaryMock.mockResolvedValue({
      data: pngBytes.buffer,
      contentType: 'image/png'
    })

    const { createMediaMarkdownResolver, loadIssueImageAttachments } =
      await import('./attachment-images')

    const images = await loadIssueImageAttachments(
      makeEntry(),
      [
        {
          id: '101',
          filename: 'shot.png',
          mimeType: 'image/png',
          size: 4
        },
        {
          id: '202',
          filename: 'notes.txt',
          mimeType: 'text/plain',
          size: 12
        }
      ],
      ['101']
    )

    expect(images).toHaveLength(1)
    expect(images[0]?.id).toBe('101')
    expect(images[0]?.dataUrl.startsWith('data:image/png;base64,')).toBe(true)

    const resolve = createMediaMarkdownResolver(images, ['101'])
    expect(resolve({ id: 'media-uuid', type: 'file', alt: 'shot.png' })).toBe(
      `![shot.png](${images[0]?.dataUrl})`
    )
    expect(resolve({ id: 'media-uuid-2', type: 'file' })).toBeNull()
  })

  it('skips oversized and non-image attachments', async () => {
    const { parseImageAttachmentMetas } = await import('./attachment-images')
    expect(
      parseImageAttachmentMetas([
        { id: '1', filename: 'big.png', mimeType: 'image/png', size: 20 * 1024 * 1024 },
        { id: '2', filename: 'icon.svg', mimeType: 'image/svg+xml', size: 100 },
        { id: '3', filename: 'ok.jpg', mimeType: 'image/jpeg', size: 100 }
      ])
    ).toEqual([{ id: '3', filename: 'ok.jpg', mimeType: 'image/jpeg', size: 100 }])
  })
})
