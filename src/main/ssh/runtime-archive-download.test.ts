import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PinnedRuntimeArchive } from './pinned-runtime-materializer'
import { downloadVerifiedArchive } from './runtime-archive-download'

const BODY = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
const NO_DELAY = [0, 0, 0]
let dir = ''
let destination = ''

function archive(body: Uint8Array = BODY): PinnedRuntimeArchive {
  return {
    label: 'Node runtime',
    url: 'https://nodejs.org/dist/node.tar.gz',
    archiveSha256: createHash('sha256').update(body).digest('hex')
  }
}

const ok = (body: Uint8Array = BODY): Response => new Response(Buffer.from(body), { status: 200 })

/** A body that delivers its first half, then fails as Chromium does when the network drops. */
function droppedMidway(): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(BODY.subarray(0, 4))
    },
    pull(controller) {
      controller.error(new Error('net::ERR_CONNECTION_RESET'))
    }
  })
  return new Response(stream, { status: 200 })
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orca-runtime-archive-'))
  destination = join(dir, 'node.tar.gz')
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})

describe('downloading a pinned runtime archive over a flaky network', () => {
  it.each([
    ['a network change', () => Promise.reject(new Error('net::ERR_NETWORK_CHANGED'))],
    ['a lost connection', () => Promise.reject(new Error('net::ERR_INTERNET_DISCONNECTED'))],
    ['a server error', () => Promise.resolve(new Response('busy', { status: 503 }))],
    ['a reset partway through the body', () => Promise.resolve(droppedMidway())]
  ])('retries after %s and still verifies the checksum', async (_name, first) => {
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(first).mockResolvedValue(ok())
    await downloadVerifiedArchive(archive(), destination, fetcher, undefined, NO_DELAY)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(new Uint8Array(await readFile(destination))).toEqual(BODY)
  })

  it('gives up after its bounded attempts with the last error', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('net::ERR_NETWORK_CHANGED'))
    await expect(
      downloadVerifiedArchive(archive(), destination, fetcher, undefined, NO_DELAY)
    ).rejects.toThrow('net::ERR_NETWORK_CHANGED')
    expect(fetcher).toHaveBeenCalledTimes(NO_DELAY.length + 1)
  })

  it.each([
    ['a missing asset', () => new Response('gone', { status: 404 })],
    ['a checksum mismatch', () => ok(new Uint8Array([9, 9]))]
  ])('never retries %s', async (_name, response) => {
    const fetcher = vi.fn<typeof fetch>(async () => response())
    await expect(
      downloadVerifiedArchive(archive(), destination, fetcher, undefined, NO_DELAY)
    ).rejects.toThrow()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('stops waiting to retry once the caller cancels', async () => {
    const controller = new AbortController()
    const fetcher = vi.fn<typeof fetch>(async () => {
      setTimeout(() => controller.abort(new Error('cancelled')), 10)
      throw new Error('net::ERR_NETWORK_CHANGED')
    })
    await expect(
      downloadVerifiedArchive(archive(), destination, fetcher, controller.signal, [60_000])
    ).rejects.toThrow('cancelled')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
