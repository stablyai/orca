import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JiraClientForSite } from '../authenticated-request'
import { JIRA_IMAGE_MAX_PENDING_READS } from '../../../shared/jira/jira-attachment-image'
import { readAttachmentImageBytes } from './image-bytes'
import {
  registerAttachmentImageGrant,
  attachmentImageGrant,
  resetAttachmentImageGrantsForTest
} from './image-grants'
import { readGrantedAttachmentImage } from './image-read'
import { handleJiraImageRequest } from './image-protocol'
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
  it('uses only a live opaque grant, never a caller URL or stored credential', async () => {
    const reference = grant()
    expect(attachmentImageGrant(reference)).not.toHaveProperty('authorization')
    expect(await readGrantedAttachmentImage('unknown')).toBeNull()
    expect(binary).not.toHaveBeenCalled()
    expect(await readGrantedAttachmentImage(reference)).toEqual({
      data: bytes,
      mimeType: 'image/png'
    })
    expect(binary).toHaveBeenCalledWith(
      client,
      'https://jira.test/rest/api/3/attachment/content/1?redirect=false',
      expect.objectContaining({ maxBytes: 8 * 1024 * 1024, signal: expect.any(AbortSignal) })
    )
    clients.mockReturnValue([])
    expect(await readGrantedAttachmentImage(reference)).toBeNull()
  })

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

  it('allows three concurrent downloads across different issues, with a bounded queue', async () => {
    const controller = new AbortController()
    binary.mockImplementation(
      (_client, _url, options: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) =>
          options.signal.addEventListener('abort', () => reject(new Error('cancelled')), {
            once: true
          })
        )
    )
    const reads = Array.from({ length: JIRA_IMAGE_MAX_PENDING_READS }, (_, id) =>
      readAttachmentImageBytes(client, { ...meta, id: String(id) }, controller.signal).catch(
        (error) => error
      )
    )
    await vi.waitFor(() => expect(binary).toHaveBeenCalledTimes(3))
    await expect(readAttachmentImageBytes(client, { ...meta, id: 'overflow' })).rejects.toThrow(
      'queue is full'
    )
    controller.abort()
    await Promise.all(reads)
    expect(binary).toHaveBeenCalledTimes(3)
  })

  it('loads the combined 48 description and comment references without rejecting a reader', async () => {
    const releases: (() => void)[] = []
    binary.mockImplementation(
      () =>
        new Promise((resolve) => {
          releases.push(() => resolve({ data: bytes.buffer, contentType: 'image/png' }))
        })
    )
    const reads = Array.from({ length: 48 }, (_, id) =>
      readAttachmentImageBytes(client, { ...meta, id: String(id) })
    )
    await vi.waitFor(() => expect(binary).toHaveBeenCalledTimes(3))
    for (let batch = 0; batch < 16; batch += 1) {
      await vi.waitFor(() => expect(releases).toHaveLength(3))
      releases.splice(0).forEach((release) => release())
    }
    expect((await Promise.all(reads)).filter(Boolean)).toHaveLength(48)
    expect(binary).toHaveBeenCalledTimes(48)
  })

  it('uses the REST attachment fallback for scoped site links while preserving Server paths', async () => {
    const scoped = {
      ...client,
      site: {
        ...client.site,
        apiBaseUrl: 'https://api.atlassian.com/ex/jira/tenant',
        authType: 'cloud' as const
      }
    }
    await readAttachmentImageBytes(scoped, { ...meta, contentUrl: '/secure/attachment/1/shot.png' })
    expect(binary).toHaveBeenCalledWith(
      scoped,
      'https://jira.test/rest/api/3/attachment/content/1?redirect=false',
      expect.anything()
    )
  })

  it('expires grants and renews them when the issue is read again', () => {
    vi.useFakeTimers()
    const reference = grant()
    vi.advanceTimersByTime(29 * 60_000)
    expect(grant()).toBe(reference)
    vi.advanceTimersByTime(29 * 60_000)
    expect(attachmentImageGrant(reference)).not.toBeNull()
    vi.advanceTimersByTime(2 * 60_000)
    expect(attachmentImageGrant(reference)).toBeNull()
  })

  it('preserves Server content paths and rejects SVG responses', async () => {
    const server = { ...client, site: { ...client.site, authType: 'server' as const } }
    expect(await readAttachmentImageBytes(server, meta)).toBeNull()
    binary.mockResolvedValue({ data: bytes.buffer, contentType: 'image/svg+xml' })
    expect(
      await readAttachmentImageBytes(server, {
        ...meta,
        contentUrl: '/secure/attachment/1/shot.png'
      })
    ).toBeNull()
    expect(binary).toHaveBeenCalledWith(
      server,
      'https://jira.test/secure/attachment/1/shot.png',
      expect.any(Object)
    )
  })
})

describe('local Jira image protocol', () => {
  it('serves bounded image bytes and headers without exposing authorization', async () => {
    const url = `orca-jira-image://attachment/${grant()}`
    const response = await handleJiraImageRequest(new Request(url))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('authorization')).toBeNull()
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)
    const head = await handleJiraImageRequest(new Request(url, { method: 'HEAD' }))
    expect(head.headers.get('content-length')).toBe('3')
    expect(await head.text()).toBe('')
  })
  it('refuses unknown, malformed, revoked and non-GET image requests', async () => {
    const url = `orca-jira-image://attachment/${grant()}`
    expect((await handleJiraImageRequest(new Request(`${url}?url=https://evil.test`))).status).toBe(
      404
    )
    expect((await handleJiraImageRequest(new Request(url, { method: 'POST' }))).status).toBe(405)
    clearAttachmentImagesForSite('site')
    expect((await handleJiraImageRequest(new Request(url))).status).toBe(404)
    expect(binary).not.toHaveBeenCalled()
  })
})
