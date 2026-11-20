import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { readAttachmentImageBytes } from './image-bytes'
import { loadIssueImageAttachments } from './images'
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
})

it('keeps a legacy inline image when the earlier cancellable reader leaves', async () => {
  const legacy = Promise.withResolvers<{ data: ArrayBuffer; contentType: string }>()
  binary.mockImplementation((_client, _url, options?: { signal?: AbortSignal }) => {
    if (!options?.signal) {
      return legacy.promise
    }
    return new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
        once: true
      })
    })
  })
  const controller = new AbortController()
  const cancelled = new Error('new reader cancelled')
  const newReading = readAttachmentImageBytes(client, meta, controller.signal)
  const cancellation = expect(newReading).rejects.toBe(cancelled)
  await vi.waitFor(() => expect(binary).toHaveBeenCalledTimes(1))

  const legacyReading = loadIssueImageAttachments(client, [meta], ['1'])
  await vi.waitFor(() => expect(binary).toHaveBeenCalledTimes(2))
  controller.abort(cancelled)
  await cancellation
  legacy.resolve({ data: bytes.buffer, contentType: 'image/png' })

  expect(await legacyReading).toMatchObject([{ id: '1', dataUrl: 'data:image/png;base64,AQID' }])
  expect(await readAttachmentImageBytes(client, meta)).toEqual({
    data: bytes,
    mimeType: 'image/png'
  })
  expect(binary).toHaveBeenCalledTimes(2)
})
