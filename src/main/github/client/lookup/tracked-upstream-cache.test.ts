import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeTempDirs } from '../../../../shared/testing/remove-temp-dirs.test-support'
import { setLocalGitRuntimeRouter } from '../../../git/command-runner/host-routing/local-git-runtime-route'
import { readLocalGitConfigSignature } from '../../repositories/local-git-config-signature'
import {
  TRACKED_UPSTREAM_SNAPSHOT_CACHE_MAX_ENTRIES,
  TRACKED_UPSTREAM_SNAPSHOT_CACHE_TTL_MS,
  doesTrackedUpstreamCacheConfigSignatureMatch,
  getTrackedUpstreamRoute,
  publishTrackedUpstreamSnapshot,
  trackedUpstreamSnapshotCache
} from './tracked-upstream-cache'
import {
  createLinkedWorktreeFixture,
  fixtureGit,
  restoreGitConfigEnv
} from './tracked-upstream-worktrees.test-support'

const roots: string[] = []
const savedEnv = {
  global: process.env.GIT_CONFIG_GLOBAL,
  nosystem: process.env.GIT_CONFIG_NOSYSTEM
}
const originalPlatform = process.platform

beforeEach(() => {
  trackedUpstreamSnapshotCache.clear()
})

afterEach(async () => {
  Object.defineProperty(process, 'platform', { value: originalPlatform })
  setLocalGitRuntimeRouter(null)
  restoreGitConfigEnv(savedEnv)
  await removeTempDirs(roots.splice(0))
})

async function readSignature(repoPath: string): Promise<string> {
  const signature = await readLocalGitConfigSignature({ repoPath, connectionId: null })
  if (!signature) {
    throw new Error('Expected a local git config signature')
  }
  return signature
}

describe('getTrackedUpstreamRoute', () => {
  it('keys linked worktrees of one repository separately', async () => {
    const { repoPath, worktreePath } = await createLinkedWorktreeFixture(roots)
    expect(getTrackedUpstreamRoute(worktreePath).cacheKey).not.toBe(
      getTrackedUpstreamRoute(repoPath).cacheKey
    )
  })

  it('separates SSH, WSL and host runtimes, including a distro named host', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const path = 'C:\\src\\app'
    const keys = [
      getTrackedUpstreamRoute(path, 'conn-1').cacheKey,
      getTrackedUpstreamRoute(path, null, { wslDistro: 'Ubuntu' }).cacheKey,
      getTrackedUpstreamRoute(path, null, { wslDistro: 'host' }).cacheKey,
      getTrackedUpstreamRoute(path).cacheKey
    ]
    expect(new Set(keys).size).toBe(4)
    expect(getTrackedUpstreamRoute(path, null, { wslDistro: 'UBUNTU' }).cacheKey).toBe(keys[1])
  })

  it('follows the project runtime router and signs only host Git on host paths', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    setLocalGitRuntimeRouter(() => 'Debian')
    expect(getTrackedUpstreamRoute('C:\\src\\app')).toMatchObject({
      runsIn: 'wsl:debian',
      signed: false
    })
    setLocalGitRuntimeRouter(() => undefined)
    expect(getTrackedUpstreamRoute('C:\\src\\app')).toMatchObject({ runsIn: 'host', signed: true })
    expect(getTrackedUpstreamRoute('\\\\wsl.localhost\\Debian\\home\\a\\app')).toMatchObject({
      runsIn: 'wsl:debian',
      signed: false
    })
    expect(getTrackedUpstreamRoute('\\\\server\\share\\app')).toMatchObject({
      runsIn: 'host',
      signed: false
    })
    expect(getTrackedUpstreamRoute('C:\\src\\app', 'conn-1')).toMatchObject({ signed: false })
  })

  it('keeps extended Windows UNC paths unsigned in their host or explicit WSL cache namespace', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const unc = '\\\\?\\UNC\\server\\share\\app'
    expect(getTrackedUpstreamRoute(unc)).toEqual({
      cacheKey: `host\0${unc}`,
      runsIn: 'host',
      signed: false
    })
    expect(getTrackedUpstreamRoute(unc, null, { wslDistro: 'Ubuntu' })).toEqual({
      cacheKey: `wsl:ubuntu\0${unc}`,
      runsIn: 'wsl:ubuntu',
      signed: false
    })
    expect(getTrackedUpstreamRoute('\\\\?\\C:\\src\\app')).toMatchObject({
      runsIn: 'host',
      signed: true
    })
  })
})

describe('doesTrackedUpstreamCacheConfigSignatureMatch', () => {
  it('validates against the caller’s own worktree, never a sibling’s', async () => {
    const { repoPath, worktreePath } = await createLinkedWorktreeFixture(roots)
    const entry = { gitConfigSignature: await readSignature(repoPath) }
    await expect(
      doesTrackedUpstreamCacheConfigSignatureMatch(
        entry,
        repoPath,
        getTrackedUpstreamRoute(repoPath)
      )
    ).resolves.toBe(true)
    await expect(
      doesTrackedUpstreamCacheConfigSignatureMatch(
        entry,
        worktreePath,
        getTrackedUpstreamRoute(worktreePath)
      )
    ).resolves.toBe(false)
  })

  it('invalidates on the caller’s config.worktree and on shared config edits', async () => {
    const { repoPath, worktreePath } = await createLinkedWorktreeFixture(roots)
    const route = getTrackedUpstreamRoute(worktreePath)
    const entry = { gitConfigSignature: await readSignature(worktreePath) }
    fixtureGit(worktreePath, 'config', '--worktree', 'remote.pushDefault', 'origin')
    await expect(
      doesTrackedUpstreamCacheConfigSignatureMatch(entry, worktreePath, route)
    ).resolves.toBe(false)
    const refreshed = { gitConfigSignature: await readSignature(worktreePath) }
    fixtureGit(repoPath, 'config', 'remote.pushDefault', 'fork')
    await expect(
      doesTrackedUpstreamCacheConfigSignatureMatch(refreshed, worktreePath, route)
    ).resolves.toBe(false)
  })
})

describe('publishTrackedUpstreamSnapshot', () => {
  const now = 1_000_000
  const entry = (expiresAt: number) => ({ expiresAt, upstreamsByBranchName: new Map() })

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(now)
  })

  afterEach(() => vi.useRealTimers())

  it('keeps the newest 512 publications, re-publishing a key as newest', () => {
    const live = now + TRACKED_UPSTREAM_SNAPSHOT_CACHE_TTL_MS
    for (let index = 0; index < TRACKED_UPSTREAM_SNAPSHOT_CACHE_MAX_ENTRIES; index += 1) {
      publishTrackedUpstreamSnapshot(`key-${index}`, entry(live))
    }
    publishTrackedUpstreamSnapshot('key-0', entry(live))
    publishTrackedUpstreamSnapshot('key-new', entry(live))
    expect(TRACKED_UPSTREAM_SNAPSHOT_CACHE_MAX_ENTRIES).toBe(512)
    expect(trackedUpstreamSnapshotCache.size).toBe(512)
    expect(trackedUpstreamSnapshotCache.has('key-0')).toBe(true)
    expect(trackedUpstreamSnapshotCache.has('key-1')).toBe(false)
    const keys = [...trackedUpstreamSnapshotCache.keys()]
    expect(keys.slice(-2)).toEqual(['key-0', 'key-new'])
    const seqs = [...trackedUpstreamSnapshotCache.values()].map((value) => value.publishedSeq)
    expect(seqs).toEqual([...seqs].sort((left, right) => left - right))
  })

  it('sweeps expired entries before evicting live ones', () => {
    publishTrackedUpstreamSnapshot('expired', entry(now - 1))
    publishTrackedUpstreamSnapshot('live', entry(now + TRACKED_UPSTREAM_SNAPSHOT_CACHE_TTL_MS))
    expect([...trackedUpstreamSnapshotCache.keys()]).toEqual(['live'])
  })
})
