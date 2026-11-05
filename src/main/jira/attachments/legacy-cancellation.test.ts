import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { readAttachmentImageBytes } from './image-bytes'
import { loadIssueImageAttachments, type JiraImageAttachment } from './images'
import * as cache from './image-cache'
import type { JiraClientForSite } from '../authenticated-request'

const { binary } = vi.hoisted(() => ({ binary: vi.fn() }))
const { JiraApiError: JiraApiErrorMock } = vi.hoisted(() => ({
  JiraApiError: class extends Error {}
}))

vi.mock('../jira-api-error', () => ({ JiraApiError: JiraApiErrorMock }))

vi.mock('../authenticated-request', () => ({
  apiBasePath: () => '/rest/api/3',
  jiraRequestBinary: binary,
  JiraApiError: JiraApiErrorMock
}))

const client: JiraClientForSite = {
  site: { id: 'site', siteUrl: 'https://jira.test', email: '', accountId: '', displayName: '' },
  authorization: 'fixture-token'
}
const meta = { id: '1', filename: 'shot.png', mimeType: 'image/png', size: 3 }
const bytes = Uint8Array.from([1, 2, 3])

beforeEach(() => {
  binary.mockReset()
})

afterEach(() => {
  cache._resetAttachmentImageCache()
  vi.restoreAllMocks()
})

it.each(['cancellable-first', 'legacy-first'] as const)(
  'retains a legacy inline image after new reader cancellation (%s)',
  async (order) => {
    const finish: (() => void)[] = []
    binary.mockImplementation(
      (_client, _url, options?: { signal?: AbortSignal }) =>
        new Promise((resolve, reject) => {
          finish.push(() => resolve({ data: bytes.buffer, contentType: 'image/png' }))
          options?.signal?.addEventListener(
            'abort',
            () => reject(new Error('new reader cancelled')),
            {
              once: true
            }
          )
        })
    )
    const legacyLoading = vi.spyOn(cache, 'loadAttachmentDataUrlWithCache')
    const controller = new AbortController()
    const readLegacy = (): Promise<{ images: JiraImageAttachment[] } | { error: unknown }> =>
      loadIssueImageAttachments(client, [meta], ['1']).then(
        (images) => ({ images }),
        (error) => ({ error })
      )
    const readNew = () =>
      readAttachmentImageBytes(client, meta, controller.signal).catch(() => null)
    const first = order === 'cancellable-first' ? readNew() : readLegacy()
    await vi.waitFor(() => expect(binary).toHaveBeenCalledTimes(1))
    const second = order === 'cancellable-first' ? readLegacy() : readNew()
    const newReading = order === 'cancellable-first' ? first : second
    const legacyReading = order === 'cancellable-first' ? second : first
    await vi.waitFor(() => expect(legacyLoading).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(binary).toHaveBeenCalledTimes(2))
    controller.abort()
    await newReading
    finish.forEach((resolve) => resolve())
    expect(await legacyReading).toMatchObject({
      images: [{ id: '1', dataUrl: 'data:image/png;base64,AQID' }]
    })
    expect(await readAttachmentImageBytes(client, meta)).toEqual({
      data: bytes,
      mimeType: 'image/png'
    })
    expect(binary).toHaveBeenCalledTimes(2)
  }
)
