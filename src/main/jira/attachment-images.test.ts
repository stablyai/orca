import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JiraClientForSite } from './client'

const { jiraRequestBinaryMock } = vi.hoisted(() => ({
  jiraRequestBinaryMock: vi.fn()
}))

vi.mock('./client', () => ({
  jiraRequestBinary: (...args: unknown[]) => jiraRequestBinaryMock(...args),
  apiBasePath: (site: { authType?: string }) =>
    site.authType === 'server' ? '/rest/api/2' : '/rest/api/3',
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
  beforeEach(async () => {
    jiraRequestBinaryMock.mockReset()
    const { _resetAttachmentImageCache } = await import('./attachment-image-cache')
    _resetAttachmentImageCache()
  })

  it('extracts attachment content ids from rendered HTML in order', async () => {
    const { extractAttachmentContentIdsFromHtml } = await import('./attachment-discovery')
    const ids = extractAttachmentContentIdsFromHtml(`
      <p>intro</p>
      <img src="https://example.atlassian.net/rest/api/3/attachment/content/101" />
      <img src="https://example.atlassian.net/secure/attachment/202/shot.png" />
      <img src="https://example.atlassian.net/rest/api/3/attachment/content/101" />
    `)
    expect(ids).toEqual(['101', '202'])
  })

  it('extracts thumbnail attachment ids', async () => {
    const { extractAttachmentContentIdsFromHtml } = await import('./attachment-discovery')
    expect(
      extractAttachmentContentIdsFromHtml(
        '<img src="https://example.atlassian.net/secure/thumbnail/10001/shot.png" />'
      )
    ).toEqual(['10001'])
    expect(
      extractAttachmentContentIdsFromHtml(
        '<img src="https://example.atlassian.net/rest/api/3/attachment/thumbnail/10002" />'
      )
    ).toEqual(['10002'])
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

  it('pairs shared alt filenames to distinct attachments then falls through', async () => {
    const { createMediaMarkdownResolver } = await import('./attachment-images')
    const images = [
      {
        id: '1',
        filename: 'image.png',
        mimeType: 'image/png',
        byteSize: 1,
        dataUrl: 'data:image/png;base64,AA=='
      },
      {
        id: '2',
        filename: 'other.png',
        mimeType: 'image/png',
        byteSize: 1,
        dataUrl: 'data:image/png;base64,BB=='
      }
    ]
    const resolve = createMediaMarkdownResolver(images, ['1', '2'])
    expect(resolve({ id: 'm1', alt: 'image.png' })).toBe('![image.png](data:image/png;base64,AA==)')
    // Exhausted filename match must not re-emit image 1
    expect(resolve({ id: 'm2', alt: 'image.png' })).toBe('![other.png](data:image/png;base64,BB==)')
  })

  it('does not re-emit an already consumed attachment for a third shared-alt node', async () => {
    const { createMediaMarkdownResolver } = await import('./attachment-images')
    const images = [
      {
        id: '1',
        filename: 'image.png',
        mimeType: 'image/png',
        byteSize: 1,
        dataUrl: 'data:image/png;base64,AA=='
      },
      {
        id: '2',
        filename: 'image.png',
        mimeType: 'image/png',
        byteSize: 1,
        dataUrl: 'data:image/png;base64,BB=='
      }
    ]
    const resolve = createMediaMarkdownResolver(images, ['1', '2'])
    expect(resolve({ id: 'm1', alt: 'image.png' })).toContain('AA==')
    expect(resolve({ id: 'm2', alt: 'image.png' })).toContain('BB==')
    expect(resolve({ id: 'm3', alt: 'image.png' })).toBeNull()
  })

  it('escapes hostile external media URLs instead of injecting markdown', async () => {
    const { createMediaMarkdownResolver } = await import('./attachment-images')
    const resolve = createMediaMarkdownResolver([], [])
    const hostile = 'https://evil.example/x?a=1)![z](javascript:alert(1))'
    const out = resolve({ url: hostile, alt: 'Image' })
    expect(out).not.toContain('](javascript:')
    expect(out).toMatch(/^!\[[^\]]*\]\(https:\/\/evil\.example/)
    // encodeURI leaves ) unencoded — pin the bug class
    expect(encodeURI(hostile)).toContain(')')
    expect(out).not.toBe(`![Image](${hostile})`)
  })

  it('returns placeholder for external URLs that remain hostile after encode', async () => {
    const { createMediaMarkdownResolver } = await import('./attachment-images')
    const resolve = createMediaMarkdownResolver([], [])
    // non-http rejected
    expect(resolve({ url: 'javascript:alert(1)', alt: 'x' })).toBe('*[x]*')
  })

  it('selects preferred ids via Option A filename fallback without sweeping all attachments', async () => {
    const { selectPreferredAttachmentIds } = await import('./attachment-discovery')
    const attachments = [
      { id: '1', filename: 'a.png', mimeType: 'image/png', size: 1 },
      { id: '2', filename: 'b.png', mimeType: 'image/png', size: 1 },
      { id: '3', filename: 'unrelated.png', mimeType: 'image/png', size: 1 }
    ]
    const selection = selectPreferredAttachmentIds({
      renderedHtmlIds: [],
      attachmentField: attachments,
      mediaAttrs: [{ alt: 'a.png' }, { alt: 'b.png' }]
    })
    expect(selection.preferredIds).toEqual(['1', '2'])
    expect(selection.fallbackRan).toBe(true)
    expect(selection.needCount).toBe(2)

    const noMedia = selectPreferredAttachmentIds({
      renderedHtmlIds: [],
      attachmentField: attachments,
      mediaAttrs: []
    })
    expect(noMedia.preferredIds).toEqual([])
    expect(noMedia.needCount).toBe(0)
  })

  it('Option A unions multiple same-filename attachments for repeated alts', async () => {
    const { selectPreferredAttachmentIds } = await import('./attachment-discovery')
    const attachments = [
      { id: '1', filename: 'image.png', mimeType: 'image/png', size: 1 },
      { id: '2', filename: 'image.png', mimeType: 'image/png', size: 1 }
    ]
    const zeroHtml = selectPreferredAttachmentIds({
      renderedHtmlIds: [],
      attachmentField: attachments,
      mediaAttrs: [{ alt: 'image.png' }, { alt: 'image.png' }]
    })
    expect(zeroHtml.preferredIds).toEqual(['1', '2'])
    expect(zeroHtml.fallbackRan).toBe(true)

    const partialHtml = selectPreferredAttachmentIds({
      renderedHtmlIds: ['1'],
      attachmentField: attachments,
      mediaAttrs: [{ alt: 'image.png' }, { alt: 'image.png' }]
    })
    expect(partialHtml.preferredIds).toEqual(['1', '2'])
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
    const { parseImageAttachmentMetas } = await import('./attachment-meta')
    expect(
      parseImageAttachmentMetas([
        { id: '1', filename: 'big.png', mimeType: 'image/png', size: 20 * 1024 * 1024 },
        { id: '2', filename: 'icon.svg', mimeType: 'image/svg+xml', size: 100 },
        { id: '3', filename: 'ok.jpg', mimeType: 'image/jpeg', size: 100 }
      ])
    ).toEqual([{ id: '3', filename: 'ok.jpg', mimeType: 'image/jpeg', size: 100 }])
  })

  it('serves a second load of the same attachment from cache', async () => {
    jiraRequestBinaryMock.mockResolvedValue({
      data: Uint8Array.from([1, 2, 3]).buffer,
      contentType: 'image/png'
    })
    const { loadIssueImageAttachments } = await import('./attachment-images')
    const entry = makeEntry()
    const field = [{ id: '9', filename: 'c.png', mimeType: 'image/png', size: 3 }]
    await loadIssueImageAttachments(entry, field, ['9'])
    await loadIssueImageAttachments(entry, field, ['9'])
    expect(jiraRequestBinaryMock).toHaveBeenCalledTimes(1)
  })

  it('singleflights concurrent cold misses for the same attachment', async () => {
    let resolveDownload: (value: { data: ArrayBuffer; contentType: string }) => void = () => {}
    jiraRequestBinaryMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDownload = resolve
        })
    )
    const { loadIssueImageAttachments } = await import('./attachment-images')
    const entry = makeEntry()
    const field = [{ id: '7', filename: 's.png', mimeType: 'image/png', size: 1 }]
    const p1 = loadIssueImageAttachments(entry, field, ['7'])
    const p2 = loadIssueImageAttachments(entry, field, ['7'])
    resolveDownload({ data: Uint8Array.from([9]).buffer, contentType: 'image/png' })
    const [a, b] = await Promise.all([p1, p2])
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(1)
    expect(jiraRequestBinaryMock).toHaveBeenCalledTimes(1)
  })

  it('warns when media resolution is incomplete', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { warnIfMediaResolutionIncomplete } = await import('./attachment-discovery')
    warnIfMediaResolutionIncomplete({
      siteId: 's',
      issueKey: 'ABC-1',
      needCount: 2,
      preferredIdCount: 1,
      resolvedCount: 0,
      fallbackRan: true
    })
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
