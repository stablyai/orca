import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NODE_RUNTIME_ASSETS, NODE_RUNTIME_PIN } from '../../shared/node-runtime-pin'
import {
  DesktopDownloadUnreachableError,
  materializeNodeRuntimeArchive
} from './pinned-runtime-materializer'
import { ReleaseMismatchError } from './runtime-archive-download'
import { setNodeDistMirrorSettingReader } from './node-dist-mirror-setting'

const TARGET = 'linux-x64-glibc'
const MIRROR = 'https://artifacts.example.internal/nodejs/dist'
const BODY = new TextEncoder().encode('pinned archive')
const originalAsset = { ...NODE_RUNTIME_ASSETS[TARGET] }
const mirrorUrl = `${MIRROR}/v${NODE_RUNTIME_PIN.version}/${originalAsset.archive}`
let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-node-mirror-'))
  Object.assign(NODE_RUNTIME_ASSETS[TARGET], {
    archiveSha256: createHash('sha256').update(BODY).digest('hex')
  })
  setNodeDistMirrorSettingReader(() => `${MIRROR}/`)
})

afterEach(async () => {
  setNodeDistMirrorSettingReader(null)
  Object.assign(NODE_RUNTIME_ASSETS[TARGET], originalAsset)
  await rm(root, { recursive: true, force: true })
})

function fetcher(serves: (url: string) => boolean) {
  return vi.fn<typeof fetch>(async (url) =>
    serves(String(url))
      ? new Response(Buffer.from(BODY), { status: 200 })
      : new Response('not here', { status: 404 })
  )
}

describe('the pinned Node download with a mirror configured', () => {
  it('downloads from the mirror and never asks nodejs.org', async () => {
    const fetch = fetcher((url) => url === mirrorUrl)

    await materializeNodeRuntimeArchive(TARGET, root, { fetcher: fetch })

    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([mirrorUrl])
  })

  it('falls back to the release URL when the mirror lacks the file', async () => {
    const fetch = fetcher((url) => url.startsWith('https://nodejs.org/'))

    await materializeNodeRuntimeArchive(TARGET, root, { fetcher: fetch })

    const urls = fetch.mock.calls.map(([url]) => String(url))
    expect(urls[0]).toBe(mirrorUrl)
    expect(urls.at(-1)).toMatch(/^https:\/\/nodejs\.org\/dist\//)
  })

  it('tries an unreachable mirror once, without its retry pauses, before nodejs.org', async () => {
    const fetch = vi.fn<typeof fetch>(async (url) => {
      if (String(url) === mirrorUrl) {
        throw new Error('net::ERR_CONNECTION_TIMED_OUT')
      }
      return new Response(Buffer.from(BODY), { status: 200 })
    })

    await materializeNodeRuntimeArchive(TARGET, root, { fetcher: fetch })

    expect(fetch.mock.calls.map(([url]) => String(url) === mirrorUrl)).toEqual([true, false])
  })

  it('rejects a mirror file that fails the pin, whatever the mirror says', async () => {
    const fetch = vi.fn<typeof fetch>(
      async () => new Response('<html>blocked</html>', { status: 200 })
    )

    await expect(
      materializeNodeRuntimeArchive(TARGET, root, { fetcher: fetch })
    ).rejects.toBeInstanceOf(ReleaseMismatchError)
  })

  it('names both addresses when neither is reachable', async () => {
    const fetch = vi.fn<typeof fetch>(async () => {
      throw new Error('net::ERR_CONNECTION_REFUSED')
    })

    const error = await materializeNodeRuntimeArchive(TARGET, root, {
      fetcher: fetch,
      retryDelaysMs: []
    }).catch((failure: unknown) => failure)

    expect(error).toBeInstanceOf(DesktopDownloadUnreachableError)
    expect(String(error)).toMatch(/the mirror .* failed too/)
  })

  it('keeps a cancel during the release attempt a cancel', async () => {
    const controller = new AbortController()
    const fetch = vi.fn<typeof fetch>(async (url) => {
      if (String(url) !== mirrorUrl) {
        controller.abort()
      }
      throw new Error('net::ERR_CONNECTION_REFUSED')
    })

    const error = await materializeNodeRuntimeArchive(TARGET, root, {
      fetcher: fetch,
      signal: controller.signal,
      retryDelaysMs: []
    }).catch((failure: unknown) => failure)

    expect(error).not.toBeInstanceOf(DesktopDownloadUnreachableError)
    expect(controller.signal.aborted).toBe(true)
  })
})
