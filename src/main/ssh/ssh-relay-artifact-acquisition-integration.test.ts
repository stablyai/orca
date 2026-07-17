import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { acquireSshRelayArtifact } from './ssh-relay-artifact-acquisition'
import { createSshRelayArtifactCacheEntryFixture } from './ssh-relay-artifact-cache-entry-fixture'

const { netFetchMock } = vi.hoisted(() => ({ netFetchMock: vi.fn() }))

vi.mock('electron', () => ({ net: { fetch: netFetchMock } }))

const temporaryDirectories: string[] = []

afterEach(async () => {
  netFetchMock.mockReset()
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('SSH relay artifact warm/cold acquisition integration', () => {
  it.each(['linux', 'win32'] as const)(
    'downloads the %s fixture once and then acquires it while the client is offline',
    async (os) => {
      const root = await mkdtemp(join(tmpdir(), 'orca-relay-artifact-acquisition-integration-'))
      temporaryDirectories.push(root)
      const fixture = await createSshRelayArtifactCacheEntryFixture({ root, os })
      const archive = await readFile(fixture.archivePath)
      netFetchMock.mockResolvedValueOnce(
        new Response(archive, {
          status: 200,
          headers: { 'content-length': String(archive.length) }
        })
      )
      const input = {
        officialManifest: fixture.officialManifest,
        host: fixture.host,
        cacheRoot: join(root, 'cache')
      }

      const cold = await acquireSshRelayArtifact(input)
      if (cold.kind !== 'ready') {
        throw new Error(`Expected ready cold acquisition, got ${cold.kind}`)
      }
      expect(cold).toMatchObject({
        source: 'download',
        artifact: { contentId: fixture.artifact.contentId },
        entry: { contentId: fixture.artifact.contentId }
      })
      await cold.lease.release()

      netFetchMock.mockRejectedValueOnce(new Error('client is offline'))
      const warm = await acquireSshRelayArtifact(input)
      if (warm.kind !== 'ready') {
        throw new Error(`Expected ready warm acquisition, got ${warm.kind}`)
      }
      try {
        expect(warm).toMatchObject({
          source: 'cache',
          artifact: { contentId: fixture.artifact.contentId },
          entry: { contentId: fixture.artifact.contentId }
        })
        await expect(warm.lease.assertOwned()).resolves.toBeUndefined()
      } finally {
        await warm.lease.release()
      }
      expect(netFetchMock).toHaveBeenCalledTimes(1)
    }
  )
})
