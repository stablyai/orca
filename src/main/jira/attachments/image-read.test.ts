import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JiraClientForSite } from '../authenticated-request'
import { readAttachmentImageBytes } from './image-bytes'
import { registerAttachmentImageGrant, resetAttachmentImageGrantsForTest } from './image-grants'
import { readGrantedAttachmentImage } from './image-read'
import { clearAttachmentImagesForSite, _resetAttachmentImageCache } from './image-cache'

const { binary, clients } = vi.hoisted(() => ({ binary: vi.fn(), clients: vi.fn() }))
vi.mock('../authenticated-request', () => ({
  apiBasePath: () => '/rest/api/3',
  jiraRequestBinary: binary
}))
vi.mock('../client', () => ({ getClients: clients }))
vi.mock('electron', () => ({ protocol: { handle: vi.fn() } }))
const client: JiraClientForSite = {
  site: { id: 'site', siteUrl: 'https://jira.test', email: '', accountId: '', displayName: '' },
  authorization: 'private-token'
}
const meta = { id: '1', filename: 'shot.png', mimeType: 'image/png', size: 3 }
const bytes = Uint8Array.from([1, 2, 3])
function grant(): string {
  return registerAttachmentImageGrant(client, meta).split('/').at(-1) ?? ''
}

beforeEach(() => {
  _resetAttachmentImageCache()
  resetAttachmentImageGrantsForTest()
  binary.mockReset().mockResolvedValue({ data: bytes.buffer, contentType: 'image/png' })
  clients.mockReset().mockReturnValue([client])
})
afterEach(() => {
  _resetAttachmentImageCache()
  vi.useRealTimers()
})

describe('authenticated Jira image reads', () => {
  it('discards a download if the site disconnects before it finishes', async () => {
    let finish: ((value: { data: ArrayBuffer; contentType: string }) => void) | undefined
    binary.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const reading = readGrantedAttachmentImage(grant())
    await vi.waitFor(() => expect(binary).toHaveBeenCalledTimes(1))
    clearAttachmentImagesForSite('site')
    finish?.({ data: bytes.buffer, contentType: 'image/png' })
    expect(await reading).toBeNull()
  })

  it('shares a download and aborts only after the last reader leaves', async () => {
    let downloadSignal: AbortSignal | undefined
    binary.mockImplementation((_client, _url, options: { signal: AbortSignal }) => {
      downloadSignal = options.signal
      return new Promise((_resolve, reject) =>
        options.signal.addEventListener('abort', () => reject(new Error('cancelled')), {
          once: true
        })
      )
    })
    const first = new AbortController()
    const second = new AbortController()
    const a = readAttachmentImageBytes(client, meta, first.signal).catch((error) => error)
    const b = readAttachmentImageBytes(client, meta, second.signal).catch((error) => error)
    await vi.waitFor(() => expect(binary).toHaveBeenCalledTimes(1))
    first.abort()
    await a
    expect(downloadSignal?.aborted).toBe(false)
    second.abort()
    await b
    expect(downloadSignal?.aborted).toBe(true)
    binary.mockResolvedValue({ data: bytes.buffer, contentType: 'image/png' })
    expect(await readAttachmentImageBytes(client, meta)).toEqual({
      data: bytes,
      mimeType: 'image/png'
    })
  })
})
