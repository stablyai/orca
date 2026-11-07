import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence/loading-store/store'
import type { RemoteFilePreviewAddress } from '../../shared/remote-file-preview-address'

vi.mock('electron', () => ({
  protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() }
}))
vi.mock('../ipc/runtime-environments/runtime-environment-registry-root', () => ({
  readRegisteredPairingRevision: vi.fn(() => 9)
}))
vi.mock('./remote-file-preview-reader', async (importOriginal) => ({
  ...(await importOriginal<typeof RemoteFilePreviewReader>()),
  statRemotePreviewFile: vi.fn(),
  readRemotePreviewChunk: vi.fn(),
  readRemotePreviewRange: vi.fn(),
  assertRemoteChunkReadsSupported: vi.fn(),
  renewRemotePreviewGrant: vi.fn()
}))

import { grantRemoteFilePreview, handleMediaPreviewRequest } from './media-preview-protocol'
import {
  RemotePreviewGrantLapsedError,
  assertRemoteChunkReadsSupported,
  renewRemotePreviewGrant,
  readRemotePreviewChunk,
  readRemotePreviewRange,
  statRemotePreviewFile
} from './remote-file-preview-reader'
import type * as RemoteFilePreviewReader from './remote-file-preview-reader'
import { readPreviewGrantRange } from './preview-grant-range-read'

// #35968: a viewer of a host file outside every workspace outlives the grant that serves it.
describe('a granted remote preview', () => {
  const emitter = new EventEmitter()
  const event = {
    sender: {
      id: 24860,
      on: vi.fn().mockImplementation((name, callback) => emitter.on(name, callback)),
      removeListener: vi
        .fn()
        .mockImplementation((name, callback) => emitter.removeListener(name, callback))
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: remote previews never read Store members.
  const store = {} as Store
  const range = (url: string, header = 'bytes=2-4') =>
    handleMediaPreviewRequest(new Request(url, { headers: { range: header } }))
  let now = 1_000_000
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    vi.mocked(statRemotePreviewFile).mockReset().mockResolvedValue({ size: 6, mtime: 1 })
    vi.mocked(readRemotePreviewChunk)
      .mockReset()
      .mockResolvedValue(Uint8Array.from([2, 3, 4]))
    vi.mocked(assertRemoteChunkReadsSupported).mockReset().mockResolvedValue(undefined)
  })
  afterEach(() => {
    vi.mocked(Date.now).mockRestore()
    emitter.emit('destroyed')
  })

  it('renews a lapsed host grant once for a burst, then streams on through the new grant', async () => {
    const granted: RemoteFilePreviewAddress = {
      environmentId: 'env-1',
      worktree: 'id:wt-1',
      grantId: 'g-1',
      absolutePath: '/tmp/clip.webm',
      expectedEnvironmentPairingRevision: 3
    }
    const minted = await grantRemoteFilePreview(event, granted, store)
    if (!minted) {
      throw new Error('Missing preview')
    }
    now += 1_500
    vi.mocked(statRemotePreviewFile).mockImplementation(async (address) =>
      address.grantId === 'g-1'
        ? Promise.reject(new RemotePreviewGrantLapsedError('terminal_file_grant_expired'))
        : { size: 6, mtime: 1 }
    )
    vi.mocked(renewRemotePreviewGrant).mockResolvedValue({ ...granted, grantId: 'g-2' })

    const burst = await Promise.all([range(minted.mediaUrl), range(minted.mediaUrl, 'bytes=0-1')])

    expect(burst.map((response) => response.status)).toEqual([206, 206])
    expect(renewRemotePreviewGrant).toHaveBeenCalledTimes(1)
    expect(readRemotePreviewChunk).toHaveBeenCalledWith(
      { ...granted, grantId: 'g-2' },
      2,
      3,
      expect.any(AbortSignal)
    )
    vi.mocked(renewRemotePreviewGrant).mockRejectedValue(new Error('gone'))
    vi.mocked(statRemotePreviewFile).mockRejectedValue(
      new RemotePreviewGrantLapsedError('terminal_file_grant_expired')
    )
    now += 1_500
    expect((await range(minted.mediaUrl)).status).toBe(502)
  })

  const lapsedGrant: RemoteFilePreviewAddress = {
    environmentId: 'env-1',
    worktree: 'id:wt-1',
    grantId: 'g-1',
    absolutePath: '/tmp/clip.webm',
    expectedEnvironmentPairingRevision: 3
  }
  const lapsedFor = (address: RemoteFilePreviewAddress) =>
    address.grantId === 'g-1'
      ? new RemotePreviewGrantLapsedError('terminal_file_grant_expired')
      : null

  // Why: the body streams after the response returns, so a chunk can find the grant lapsed while its stat is cached.
  it('renews a grant that lapses under a streamed chunk read', async () => {
    const minted = await grantRemoteFilePreview(event, lapsedGrant, store)
    if (!minted) {
      throw new Error('Missing preview')
    }
    vi.mocked(renewRemotePreviewGrant)
      .mockReset()
      .mockResolvedValue({ ...lapsedGrant, grantId: 'g-2' })
    vi.mocked(readRemotePreviewChunk).mockImplementation(async (address) => {
      const lapsed = lapsedFor(address)
      if (lapsed) {
        throw lapsed
      }
      return Uint8Array.from([2, 3, 4])
    })

    const response = await range(minted.mediaUrl)

    expect(response.status).toBe(206)
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([2, 3, 4])
    expect(renewRemotePreviewGrant).toHaveBeenCalledTimes(1)
  })

  it('never finishes a stream from a grant renewed onto a rewritten file', async () => {
    const minted = await grantRemoteFilePreview(event, lapsedGrant, store)
    if (!minted) {
      throw new Error('Missing preview')
    }
    vi.mocked(renewRemotePreviewGrant)
      .mockReset()
      .mockResolvedValue({ ...lapsedGrant, grantId: 'g-2' })
    vi.mocked(statRemotePreviewFile).mockImplementation(async (address) =>
      address.grantId === 'g-2' ? { size: 6, mtime: 2 } : { size: 6, mtime: 1 }
    )
    vi.mocked(readRemotePreviewChunk).mockImplementation(async (address) => {
      const lapsed = lapsedFor(address)
      if (lapsed) {
        throw lapsed
      }
      return Uint8Array.from([9, 9, 9])
    })

    const response = await range(minted.mediaUrl)

    await expect(response.arrayBuffer()).rejects.toThrow()
    expect(readRemotePreviewChunk).not.toHaveBeenCalledWith(
      expect.objectContaining({ grantId: 'g-2' }),
      expect.anything(),
      expect.anything(),
      expect.anything()
    )
  })

  // Why: pdf.js reads ranges over IPC, not orca-media, and a paused reader outlives its grant too.
  it('renews a lapsed grant for a PDF range read over IPC', async () => {
    const pdf = { ...lapsedGrant, absolutePath: '/tmp/report.pdf' }
    vi.mocked(readRemotePreviewRange).mockResolvedValue(new TextEncoder().encode('%PDF-1.7'))
    const minted = await grantRemoteFilePreview(event, pdf, store)
    if (!minted) {
      throw new Error('Missing preview')
    }
    now += 1_500
    vi.mocked(renewRemotePreviewGrant)
      .mockReset()
      .mockResolvedValue({ ...pdf, grantId: 'g-2' })
    vi.mocked(readRemotePreviewRange).mockImplementation(async (address) => {
      const lapsed = lapsedFor(address)
      if (lapsed) {
        throw lapsed
      }
      return new TextEncoder().encode('PDF')
    })

    const bytes = await readPreviewGrantRange(event.sender, minted.mediaUrl, 1, 3)

    expect(new TextDecoder().decode(bytes)).toBe('PDF')
    expect(renewRemotePreviewGrant).toHaveBeenCalledTimes(1)
  })
})
