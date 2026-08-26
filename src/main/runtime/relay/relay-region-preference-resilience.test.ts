import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RelayRegionPreferenceResolver } from './relay-region-preference'

const DIRECTOR = 'https://relay.example.test'
const ASIA = 'https://asia-c1.relay.example.test'
const tempPaths: string[] = []

afterEach(() => {
  for (const path of tempPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

describe('Relay region preference resilience', () => {
  it('shares one catalog and probe cycle across concurrent resolutions', async () => {
    const path = mkdtempSync(join(tmpdir(), 'orca-relay-region-concurrency-'))
    tempPaths.push(path)
    let releaseFirstProbe: ((latency: number) => void) | undefined
    const firstProbe = new Promise<number>((resolve) => {
      releaseFirstProbe = resolve
    })
    let probeCount = 0
    const probe = vi.fn(async () => {
      probeCount += 1
      return probeCount === 1 ? await firstProbe : 20
    })
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ v: 1, regions: [{ region: 'asia-east2', probeOrigins: [ASIA] }] })
    )
    const resolver = new RelayRegionPreferenceResolver({
      directorUrl: DIRECTOR,
      userDataPath: path,
      fetch,
      probe,
      now: () => 1_000
    })

    const first = resolver.resolve()
    const second = resolver.resolve()
    await vi.waitFor(() => expect(probe).toHaveBeenCalledOnce())
    releaseFirstProbe?.(20)

    await expect(Promise.all([first, second])).resolves.toEqual(['asia-east2', 'asia-east2'])
    expect(fetch).toHaveBeenCalledOnce()
    expect(probe).toHaveBeenCalledTimes(3)
  })
})
