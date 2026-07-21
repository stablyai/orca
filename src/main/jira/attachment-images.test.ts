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
    expect(jiraRequestBinaryMock).toHaveBeenCalledWith(
      expect.anything(),
      'https://example.atlassian.net/rest/api/3/attachment/content/101?redirect=false'
    )

    const resolve = createMediaMarkdownResolver(images, ['101'])
    const resolved = `![shot.png](${images[0]?.dataUrl})`
    expect(resolve({ id: 'media-uuid', type: 'file', alt: 'shot.png' })).toBe(resolved)
    expect(resolve({ id: 'media-uuid', type: 'file' })).toBe(resolved)
    expect(resolve({ id: 'media-uuid-2', type: 'file' })).toBeNull()
  })

  it('downloads only referenced attachments after prioritizing the complete metadata list', async () => {
    jiraRequestBinaryMock.mockResolvedValue({
      data: Uint8Array.from([1]).buffer,
      contentType: 'image/png'
    })
    const { loadIssueImageAttachments } = await import('./attachment-images')
    const attachments = Array.from({ length: 13 }, (_, index) => ({
      id: String(index + 1),
      filename: `${index + 1}.png`,
      mimeType: 'image/png',
      size: 1
    }))

    const images = await loadIssueImageAttachments(makeEntry(), attachments, ['13'])

    expect(images.map((image) => image.id)).toEqual(['13'])
    expect(jiraRequestBinaryMock).toHaveBeenCalledTimes(1)
    expect(jiraRequestBinaryMock).toHaveBeenCalledWith(
      expect.anything(),
      'https://example.atlassian.net/rest/api/3/attachment/content/13?redirect=false'
    )
  })

  it('does not download attachments when rendered content references none', async () => {
    const { loadIssueImageAttachments } = await import('./attachment-images')

    await expect(
      loadIssueImageAttachments(
        makeEntry(),
        [{ id: '1', filename: 'unrelated.png', mimeType: 'image/png', size: 1 }],
        []
      )
    ).resolves.toEqual([])
    expect(jiraRequestBinaryMock).not.toHaveBeenCalled()
  })

  it('uses the attachment content URI supplied by self-hosted Jira', async () => {
    jiraRequestBinaryMock.mockResolvedValue({
      data: Uint8Array.from([1]).buffer,
      contentType: 'image/png'
    })
    const entry = makeEntry()
    entry.site = {
      ...entry.site,
      siteUrl: 'https://jira.example.com/jira',
      authType: 'server'
    }
    const { loadIssueImageAttachments } = await import('./attachment-images')

    await loadIssueImageAttachments(
      entry,
      [
        {
          id: '42',
          filename: 'server.png',
          mimeType: 'image/png',
          size: 1,
          content: 'https://jira.example.com/jira/secure/attachment/42/server.png'
        }
      ],
      ['42']
    )

    expect(jiraRequestBinaryMock).toHaveBeenCalledWith(
      expect.anything(),
      'https://jira.example.com/jira/secure/attachment/42/server.png'
    )
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
