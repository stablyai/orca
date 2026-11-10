import { beforeEach, describe, expect, it, vi } from 'vitest'

const { jiraRequestBinaryMock } = vi.hoisted(() => ({
  jiraRequestBinaryMock: vi.fn()
}))

const { JiraApiError: JiraApiErrorMock } = vi.hoisted(() => ({
  JiraApiError: class JiraApiError extends Error {
    status: number | null
    constructor(message: string, status: number | null = null) {
      super(message)
      this.status = status
    }
  }
}))

vi.mock('../jira-api-error', () => ({ JiraApiError: JiraApiErrorMock }))

vi.mock('../authenticated-request', () => ({
  jiraRequestBinary: (...args: unknown[]) => jiraRequestBinaryMock(...args),
  apiBasePath: (site: { authType?: string }) =>
    site.authType === 'server' ? '/rest/api/2' : '/rest/api/3',
  JiraApiError: JiraApiErrorMock
}))

describe('attachment image helpers', () => {
  beforeEach(async () => {
    jiraRequestBinaryMock.mockReset()
    const { _resetAttachmentImageCache } = await import('./image-cache')
    _resetAttachmentImageCache()
  })

  it('does not re-emit an already consumed attachment for a third shared-alt node', async () => {
    const { createMediaMarkdownResolver } = await import('./images')
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
})
