import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { lookupSshRelayArtifactCacheEntry } from './ssh-relay-artifact-cache-entry'
import { createSshRelayArtifactCacheEntryFixture } from './ssh-relay-artifact-cache-entry-fixture'
import { acquireSshRelayArtifactCacheInUseLease } from './ssh-relay-artifact-cache-in-use-lease'
import { populateSshRelayArtifactCache } from './ssh-relay-artifact-cache-population'

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

describe('SSH relay artifact cache cold population integration', () => {
  it.each(['linux', 'win32'] as const)(
    'composes the real verified download, %s publication, and in-use lease',
    async (os) => {
      const root = await mkdtemp(join(tmpdir(), 'orca-relay-cache-population-integration-'))
      temporaryDirectories.push(root)
      const fixture = await createSshRelayArtifactCacheEntryFixture({ root, os })
      const archive = await readFile(fixture.archivePath)
      netFetchMock.mockResolvedValueOnce(
        new Response(archive, {
          status: 200,
          headers: { 'content-length': String(archive.length) }
        })
      )
      const cacheRoot = join(root, 'cache')

      const result = await populateSshRelayArtifactCache({
        cacheRoot,
        artifact: fixture.artifact
      })
      try {
        expect(result.entry).toMatchObject({
          contentId: fixture.artifact.contentId,
          tupleId: fixture.artifact.tupleId,
          files: fixture.artifact.archive.fileCount,
          expandedBytes: fixture.artifact.archive.expandedSize
        })
        for (const [path, bytes] of fixture.fileBytes) {
          await expect(
            readFile(join(result.entry.runtimeRoot, ...path.split('/')))
          ).resolves.toEqual(bytes)
        }
        await expect(readdir(join(cacheRoot, 'downloads'))).resolves.toEqual([])
        await expect(result.lease.assertOwned()).resolves.toBeUndefined()
      } finally {
        await result.lease.release()
      }
      const warm = await lookupSshRelayArtifactCacheEntry({ cacheRoot, artifact: fixture.artifact })
      if (warm.kind !== 'hit') {
        throw new Error('Expected the freshly populated cache entry to remain warm')
      }
      const warmLease = await acquireSshRelayArtifactCacheInUseLease({
        cacheRoot,
        entry: warm.entry
      })
      await warmLease.release()
      expect(netFetchMock).toHaveBeenCalledTimes(1)
    }
  )
})
