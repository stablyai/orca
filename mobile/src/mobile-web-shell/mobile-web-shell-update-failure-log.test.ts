import { describe, expect, it } from 'vitest'
import { createFakeGenerationFileSystem } from './generation-file-system-fake'
import { createGenerationStore } from './generation-store'
import { deriveHostCacheKey } from './host-cache-key'
import type { MobileWebShellUpdateFailure } from './mobile-web-shell-update-failure'
import {
  MAX_UPDATE_FAILURES,
  MAX_UPDATE_FAILURES_PER_HOST,
  appendUpdateFailure
} from './mobile-web-shell-update-failure-log'

const LOG = 'update-failures.json'

function failure(hostId: string, at: number): MobileWebShellUpdateFailure {
  return {
    hostId,
    at,
    reason: 'asset-checksum-mismatch',
    hostCode: null,
    offeredBuildId: 'c'.repeat(64),
    cachedBuildId: 'b'.repeat(64),
    outcome: 'opened-cached',
    wall: null
  }
}

function appendAll(entries: readonly MobileWebShellUpdateFailure[]): MobileWebShellUpdateFailure[] {
  return entries.reduce<MobileWebShellUpdateFailure[]>(appendUpdateFailure, [])
}

describe('appendUpdateFailure', () => {
  it('keeps five per host and evicts that host oldest-first', () => {
    const kept = appendAll(Array.from({ length: 7 }, (_, at) => failure('host-1', at)))
    expect(kept.map((entry) => entry.at)).toEqual([2, 3, 4, 5, 6])
    expect(kept).toHaveLength(MAX_UPDATE_FAILURES_PER_HOST)
  })

  it("never evicts one host's record for another host's failures below the ceiling", () => {
    const kept = appendAll([
      failure('host-1', 0),
      ...Array.from({ length: 9 }, (_, at) => failure('host-2', at + 1))
    ])
    expect(kept.filter((entry) => entry.hostId === 'host-1')).toHaveLength(1)
    expect(kept.filter((entry) => entry.hostId === 'host-2')).toHaveLength(5)
  })

  it('holds a ceiling across hosts, evicting the oldest of all', () => {
    const kept = appendAll(Array.from({ length: 30 }, (_, at) => failure(`host-${at}`, at)))
    expect(kept).toHaveLength(MAX_UPDATE_FAILURES)
    expect(kept[0]?.at).toBe(10)
  })

  it('drops a build id that is not a digest rather than keep host text', () => {
    const [entry] = appendUpdateFailure([], {
      ...failure('host-1', 0),
      offeredBuildId: 'https://host/?token=SECRET'
    })
    expect(entry?.offeredBuildId).toBeNull()
  })
})

describe('the generation store keeps the log', () => {
  it('writes, reads back and survives a relaunch', async () => {
    const fileSystem = createFakeGenerationFileSystem()
    await createGenerationStore({ fileSystem }).recordUpdateFailure(failure('host-1', 5))
    expect(await createGenerationStore({ fileSystem }).readUpdateFailures()).toEqual([
      failure('host-1', 5)
    ])
  })

  it("forgets one host's records and leaves the others", async () => {
    const fileSystem = createFakeGenerationFileSystem()
    const store = createGenerationStore({ fileSystem })
    await store.recordUpdateFailure(failure('host-1', 1))
    await store.recordUpdateFailure(failure('host-2', 2))
    await store.forgetHostUpdateFailures('host-1')
    expect((await store.readUpdateFailures()).map((entry) => entry.hostId)).toEqual(['host-2'])
    await store.forgetHostUpdateFailures('host-2')
    expect(fileSystem.text(LOG)).toBeNull()
  })

  it("outlives the host's own cache, which a recovery deletes", async () => {
    const fileSystem = createFakeGenerationFileSystem()
    const store = createGenerationStore({ fileSystem })
    await store.recordUpdateFailure(failure('host-1', 1))
    await store.deleteHostCache(deriveHostCacheKey('host-1'))
    expect(await store.readUpdateFailures()).toHaveLength(1)
  })

  it('reads a corrupt log as empty and keeps the entries that still parse', async () => {
    const fileSystem = createFakeGenerationFileSystem()
    const store = createGenerationStore({ fileSystem })
    await fileSystem.writeText(`${fileSystem.rootUri}/${LOG}`, '{not json')
    expect(await store.readUpdateFailures()).toEqual([])
    await fileSystem.writeText(
      `${fileSystem.rootUri}/${LOG}`,
      JSON.stringify([failure('host-1', 1), { ...failure('host-1', 2), url: 'wss://x/?t=1' }])
    )
    expect(await store.readUpdateFailures()).toEqual([failure('host-1', 1)])
  })

  it('never rejects: a disk that refuses the write costs the record, not the shell', async () => {
    const fileSystem = createFakeGenerationFileSystem()
    fileSystem.failWritesAt(LOG)
    const store = createGenerationStore({ fileSystem })
    await expect(store.recordUpdateFailure(failure('host-1', 1))).resolves.toBeUndefined()
    expect(await store.readUpdateFailures()).toEqual([])
  })

  it('is not mistaken for a host directory', async () => {
    const fileSystem = createFakeGenerationFileSystem()
    const store = createGenerationStore({ fileSystem })
    await store.recordUpdateFailure(failure('host-1', 1))
    await store.sweepStagedGenerations()
    expect(fileSystem.text(LOG)).not.toBeNull()
  })
})
