import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createSshRelayArtifactCacheEvictionFixture } from './ssh-relay-artifact-cache-eviction-fixture'
import {
  evictSshRelayArtifactCache,
  SSH_RELAY_ARTIFACT_CACHE_EVICTION_LIMITS
} from './ssh-relay-artifact-cache-eviction'
import { acquireSshRelayArtifactCacheInUseLease } from './ssh-relay-artifact-cache-in-use-lease'
import { acquireSshRelayArtifactCacheLock } from './ssh-relay-artifact-cache-lock'
import type { SshRelayDigest } from './ssh-relay-runtime-identity'

const temporaryDirectories: string[] = []

async function cacheRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-relay-cache-eviction-'))
  temporaryDirectories.push(root)
  return join(root, 'cache')
}

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

describe('SSH relay artifact cache eviction', () => {
  it('pins the 2 GiB cap and bounded stable-tree scan', () => {
    expect(SSH_RELAY_ARTIFACT_CACHE_EVICTION_LIMITS).toEqual({
      maximumBytes: 2 * 1024 * 1024 * 1024,
      transactionTimeoutMs: 5 * 60_000,
      maximumMembersPerEntry: 10_000
    })
    expect(Object.isFrozen(SSH_RELAY_ARTIFACT_CACHE_EVICTION_LIMITS)).toBe(true)
  })

  it('rejects invalid budgets and protected identities before touching cache state', async () => {
    const root = await cacheRoot()
    await expect(evictSshRelayArtifactCache({ cacheRoot: root, maximumBytes: -1 })).rejects.toThrow(
      /maximum bytes/i
    )
    await expect(
      evictSshRelayArtifactCache({
        cacheRoot: root,
        protectedContentIds: ['not-a-digest' as SshRelayDigest]
      })
    ).rejects.toThrow(/content id/i)
  })

  it('accounts exact logical bytes and evicts least-recently-used idle content', async () => {
    vi.useFakeTimers()
    const root = await cacheRoot()
    vi.setSystemTime(1_000)
    const oldest = await createSshRelayArtifactCacheEvictionFixture({
      cacheRoot: root,
      character: 'a'
    })
    const firstLease = await acquireSshRelayArtifactCacheInUseLease({
      cacheRoot: root,
      entry: oldest.entry
    })
    await firstLease.release()
    vi.setSystemTime(2_000)
    const newest = await createSshRelayArtifactCacheEvictionFixture({
      cacheRoot: root,
      character: 'b'
    })
    const secondLease = await acquireSshRelayArtifactCacheInUseLease({
      cacheRoot: root,
      entry: newest.entry
    })
    await secondLease.release()

    const result = await evictSshRelayArtifactCache({
      cacheRoot: root,
      maximumBytes: newest.logicalBytes
    })

    expect(result).toMatchObject({
      initialBytes: oldest.logicalBytes + newest.logicalBytes,
      finalBytes: newest.logicalBytes,
      reclaimedBytes: oldest.logicalBytes,
      evictedContentIds: [oldest.entry.contentId]
    })
    await expect(stat(oldest.entry.entryPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(newest.entry.entryPath)).resolves.toMatchObject({
      isDirectory: expect.any(Function)
    })
  })

  it('never evicts active references and becomes evictable after every release', async () => {
    const root = await cacheRoot()
    const value = await createSshRelayArtifactCacheEvictionFixture({
      cacheRoot: root,
      character: 'a'
    })
    const first = await acquireSshRelayArtifactCacheInUseLease({
      cacheRoot: root,
      entry: value.entry
    })
    const second = await acquireSshRelayArtifactCacheInUseLease({
      cacheRoot: root,
      entry: value.entry
    })
    const retained = await evictSshRelayArtifactCache({ cacheRoot: root, maximumBytes: 0 })
    expect(retained).toMatchObject({ finalBytes: value.logicalBytes, evictedContentIds: [] })

    await Promise.all([first.release(), second.release()])
    const removed = await evictSshRelayArtifactCache({ cacheRoot: root, maximumBytes: 0 })
    expect(removed.evictedContentIds).toEqual([value.entry.contentId])
  })

  it('retains hard-protected content and prefers current/previous content while it fits', async () => {
    const root = await cacheRoot()
    const hard = await createSshRelayArtifactCacheEvictionFixture({
      cacheRoot: root,
      character: 'a'
    })
    const preferred = await createSshRelayArtifactCacheEvictionFixture({
      cacheRoot: root,
      character: 'b'
    })
    const ordinary = await createSshRelayArtifactCacheEvictionFixture({
      cacheRoot: root,
      character: 'c'
    })
    const result = await evictSshRelayArtifactCache({
      cacheRoot: root,
      maximumBytes: hard.logicalBytes + preferred.logicalBytes,
      protectedContentIds: [hard.entry.contentId],
      preferredRetentionContentIds: [preferred.entry.contentId]
    })
    expect(result.evictedContentIds).toEqual([ordinary.entry.contentId])

    const forced = await evictSshRelayArtifactCache({
      cacheRoot: root,
      maximumBytes: hard.logicalBytes,
      protectedContentIds: [hard.entry.contentId],
      preferredRetentionContentIds: [preferred.entry.contentId]
    })
    expect(forced.evictedContentIds).toEqual([preferred.entry.contentId])
    expect(forced.finalBytes).toBe(hard.logicalBytes)
  })

  it('preserves malformed, live, and remote-host lease state as ambiguous', async () => {
    const root = await cacheRoot()
    const values = await Promise.all(
      ['a', 'b', 'c'].map((character) =>
        createSshRelayArtifactCacheEvictionFixture({ cacheRoot: root, character })
      )
    )
    const owners = [
      '{not-json',
      JSON.stringify({
        schemaVersion: 1,
        contentId: values[1].entry.contentId,
        token: 'd'.repeat(32),
        hostname: hostname(),
        pid: process.pid,
        acquiredAtMs: 0,
        heartbeatAtMs: 0
      }),
      JSON.stringify({
        schemaVersion: 1,
        contentId: values[2].entry.contentId,
        token: 'e'.repeat(32),
        hostname: 'another-host',
        pid: 2_147_483_647,
        acquiredAtMs: 0,
        heartbeatAtMs: 0
      })
    ]
    for (const [index, value] of values.entries()) {
      const token = index === 0 ? 'f'.repeat(32) : index === 1 ? 'd'.repeat(32) : 'e'.repeat(32)
      const leasePath = join(root, 'in-use', value.entry.contentId.slice(7), `${token}.lease`)
      await mkdir(leasePath, { recursive: true })
      await writeFile(join(leasePath, 'owner.json'), `${owners[index]}\n`)
    }
    const result = await evictSshRelayArtifactCache({ cacheRoot: root, maximumBytes: 0 })
    expect(result.evictedContentIds).toEqual([])
    expect(result.finalBytes).toBe(values.reduce((total, value) => total + value.logicalBytes, 0))
  })

  it('reclaims only a confirmed stale same-host dead lease before eviction', async () => {
    const root = await cacheRoot()
    const value = await createSshRelayArtifactCacheEvictionFixture({
      cacheRoot: root,
      character: 'a'
    })
    const token = 'd'.repeat(32)
    const leasePath = join(root, 'in-use', value.entry.contentId.slice(7), `${token}.lease`)
    await mkdir(leasePath, { recursive: true })
    await writeFile(
      join(leasePath, 'owner.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        contentId: value.entry.contentId,
        token,
        hostname: hostname(),
        pid: 2_147_483_647,
        acquiredAtMs: 0,
        heartbeatAtMs: 0
      })}\n`
    )
    const result = await evictSshRelayArtifactCache({ cacheRoot: root, maximumBytes: 0 })
    expect(result.evictedContentIds).toEqual([value.entry.contentId])
    await expect(stat(leasePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves staging and safely settles cancellation behind a content lock', async () => {
    const root = await cacheRoot()
    const value = await createSshRelayArtifactCacheEvictionFixture({
      cacheRoot: root,
      character: 'a'
    })
    await mkdir(`${value.entry.entryPath}.pending-${'f'.repeat(32)}`)
    const staged = await evictSshRelayArtifactCache({ cacheRoot: root, maximumBytes: 0 })
    expect(staged.evictedContentIds).toEqual([])

    await rm(`${value.entry.entryPath}.pending-${'f'.repeat(32)}`, { recursive: true })
    const lock = await acquireSshRelayArtifactCacheLock({
      cacheRoot: root,
      contentId: value.entry.contentId
    })
    const controller = new AbortController()
    const pending = evictSshRelayArtifactCache({
      cacheRoot: root,
      maximumBytes: 0,
      signal: controller.signal
    })
    controller.abort(new Error('cancel eviction wait'))
    await expect(pending).rejects.toThrow(/cancel eviction wait/i)
    await lock.release()
    await expect(stat(value.entry.entryPath)).resolves.toMatchObject({
      isDirectory: expect.any(Function)
    })
  })

  it('serializes concurrent evictors and protects an unsafe linked tree', async () => {
    const root = await cacheRoot()
    const first = await createSshRelayArtifactCacheEvictionFixture({
      cacheRoot: root,
      character: 'a'
    })
    const second = await createSshRelayArtifactCacheEvictionFixture({
      cacheRoot: root,
      character: 'b'
    })
    const [left, right] = await Promise.all([
      evictSshRelayArtifactCache({ cacheRoot: root, maximumBytes: second.logicalBytes }),
      evictSshRelayArtifactCache({ cacheRoot: root, maximumBytes: second.logicalBytes })
    ])
    expect(new Set([...left.evictedContentIds, ...right.evictedContentIds])).toEqual(
      new Set([first.entry.contentId])
    )

    const unsafe = await createSshRelayArtifactCacheEvictionFixture({
      cacheRoot: root,
      character: 'c'
    })
    await symlink(
      join(unsafe.entry.runtimeRoot, 'relay.js'),
      join(unsafe.entry.runtimeRoot, 'link')
    )
    const result = await evictSshRelayArtifactCache({ cacheRoot: root, maximumBytes: 0 })
    expect(result.evictedContentIds).not.toContain(unsafe.entry.contentId)
    expect(await readFile(join(unsafe.entry.runtimeRoot, 'relay.js'))).toHaveLength(33)
  })
})
