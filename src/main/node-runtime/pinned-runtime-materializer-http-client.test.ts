import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NODE_RUNTIME_ASSETS, NODE_RUNTIME_PIN } from '../../shared/node-runtime-pin'
import { setMainHttpClient } from '../network/http-client'
import { materializeNodeRuntimeArchive } from './pinned-runtime-materializer'

const TARGET = 'linux-x64-glibc' as const
const originalAsset = { ...NODE_RUNTIME_ASSETS[TARGET] }
let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-node-runtime-http-client-'))
})

afterEach(async () => {
  setMainHttpClient(null)
  Object.assign(NODE_RUNTIME_ASSETS[TARGET], originalAsset)
  await rm(root, { recursive: true, force: true })
})

// Why it matters: the desktop installs Chromium's session-backed client, so the download follows
// system, PAC and Orca proxy settings (and proxy login). A plain undici fetch would bypass them.
describe('pinned Node runtime download', () => {
  it('goes through the installed main HTTP client when the deploy passes no fetcher', async () => {
    const body = new TextEncoder().encode('node runtime archive bytes')
    Object.assign(NODE_RUNTIME_ASSETS[TARGET], {
      archiveSha256: createHash('sha256').update(body).digest('hex')
    })
    const fetch = vi.fn(async () => new Response(Buffer.from(body), { status: 200 }))
    const globalFetch = vi.spyOn(globalThis, 'fetch')
    setMainHttpClient({ fetch, proxySession: () => null })

    // The deploy paths (SSH, WSL host, Windows host) all call it with only a signal.
    const cached = await materializeNodeRuntimeArchive(TARGET, join(root, 'cache'), {})

    expect(cached.endsWith(originalAsset.archive)).toBe(true)
    expect(fetch).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining(`/v${NODE_RUNTIME_PIN.version}/${originalAsset.archive}`),
      expect.objectContaining({ redirect: 'follow' })
    )
    expect(globalFetch).not.toHaveBeenCalled()
    globalFetch.mockRestore()
  })
})
