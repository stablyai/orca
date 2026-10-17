import {
  closeTestStores,
  createStore,
  makeRepo,
  readDataFile,
  testState,
  writeDataFile
} from './persistence-test-harness'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDefaultPersistedState } from '../shared/constants'
import {
  MAX_REMOVED_REPO_ID_TOMBSTONES,
  normalizeRemovedRepoIdTombstones,
  recordRemovedRepoIdTombstone
} from './persistence/tracking-repos/removed-repo-id-tombstones'
import { resolveRepoIdForExistingFolder } from './repo-registration-id'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('./telemetry/client', () => ({ track: vi.fn() }))
vi.mock('./telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))

const RUNTIME_HOST = 'runtime:env-1'

describe('removed repo id readoption', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
  })

  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('gives a folder registered again on the same host the id it had before removal', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ id: 'old-id', path: '/work/vault/infra/pkg' }))
    store.removeProjectForHost('old-id', 'local')

    expect(resolveRepoIdForExistingFolder(store, { path: '/work/vault/infra/pkg/' })).toBe('old-id')
  })

  it('hands a remembered id out once', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ id: 'old-id', path: '/repo' }))
    store.removeProjectForHost('old-id', 'local')

    expect(store.claimRemovedRepoId({ path: '/repo' })).toBe('old-id')
    expect(store.claimRemovedRepoId({ path: '/repo' })).toBeNull()
  })

  it('mints a fresh id for a folder that was never removed', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ id: 'old-id', path: '/repo' }))
    store.removeProjectForHost('old-id', 'local')

    const id = resolveRepoIdForExistingFolder(store, { path: '/another-repo' })

    expect(id).not.toBe('old-id')
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('does not carry an id across hosts', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ id: 'old-id', path: '/repo', executionHostId: RUNTIME_HOST }))
    store.removeProjectForHost('old-id', RUNTIME_HOST)

    expect(store.claimRemovedRepoId({ path: '/repo' })).toBeNull()
    expect(store.claimRemovedRepoId({ path: '/repo', connectionId: 'ssh-1' })).toBeNull()
    expect(store.claimRemovedRepoId({ path: '/repo', executionHostId: RUNTIME_HOST })).toBe(
      'old-id'
    )
  })

  it('remembers the latest id when the same folder is removed twice', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ id: 'first', path: '/repo' }))
    store.removeProjectForHost('first', 'local')
    store.addRepo(makeRepo({ id: 'second', path: '/repo' }))
    store.removeProjectForHost('second', 'local')

    expect(store.claimRemovedRepoId({ path: '/repo' })).toBe('second')
    expect(store.claimRemovedRepoId({ path: '/repo' })).toBeNull()
  })

  it('holds back an id a live repo on the same host has, until that repo is gone', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ id: 'shared-id', path: '/repo' }))
    store.removeProjectForHost('shared-id', 'local')
    store.addRepo(makeRepo({ id: 'shared-id', path: '/moved' }))

    expect(store.claimRemovedRepoId({ path: '/repo' })).toBeNull()

    store.removeProjectForHost('shared-id', 'local')
    expect(store.claimRemovedRepoId({ path: '/repo' })).toBe('shared-id')
  })

  it('remembers only the host the repo was removed from', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ id: 'shared-id', path: '/repo' }))
    store.addRepo(makeRepo({ id: 'shared-id', path: '/repo', executionHostId: RUNTIME_HOST }))
    store.removeProjectForHost('shared-id', RUNTIME_HOST)

    expect(store.claimRemovedRepoId({ path: '/repo' })).toBeNull()
    expect(store.claimRemovedRepoId({ path: '/repo', executionHostId: RUNTIME_HOST })).toBe(
      'shared-id'
    )
  })

  it('writes the removal to disk so a restarted app can still readopt the id', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ id: 'old-id', path: '/repo' }))
    store.removeProjectForHost('old-id', 'local')
    store.flush()

    expect(readDataFile()).toMatchObject({
      removedRepoIdTombstones: [
        { repoId: 'old-id', hostId: 'local', pathKey: '/repo', removedAt: expect.any(Number) }
      ]
    })
  })

  it('still knows the id after the profile is loaded again', async () => {
    writeDataFile({
      ...getDefaultPersistedState(testState.dir),
      removedRepoIdTombstones: [
        { repoId: 'old-id', hostId: 'local', pathKey: '/repo', removedAt: 1 }
      ]
    })
    const store = await createStore()

    expect(store.claimRemovedRepoId({ path: '/repo' })).toBe('old-id')
  })

  it('drops malformed persisted entries', () => {
    expect(
      normalizeRemovedRepoIdTombstones([
        { repoId: 'ok', hostId: 'local', pathKey: '/repo', removedAt: 1 },
        { repoId: '', hostId: 'local', pathKey: '/repo', removedAt: 1 },
        { repoId: 'no-host', hostId: 'nowhere', pathKey: '/repo', removedAt: 1 },
        { repoId: 'no-path', hostId: 'local', pathKey: '', removedAt: 1 },
        { repoId: 'no-time', hostId: 'local', pathKey: '/repo' },
        null,
        'text'
      ])
    ).toEqual([{ repoId: 'ok', hostId: 'local', pathKey: '/repo', removedAt: 1 }])
    expect(normalizeRemovedRepoIdTombstones({ repoId: 'ok' })).toEqual([])
  })

  it('keeps only the most recent removals', () => {
    let tombstones = normalizeRemovedRepoIdTombstones([])
    for (let index = 0; index < MAX_REMOVED_REPO_ID_TOMBSTONES + 5; index += 1) {
      tombstones = recordRemovedRepoIdTombstone(
        tombstones,
        makeRepo({ id: `repo-${index}`, path: `/repo-${index}` }),
        index
      )
    }

    expect(tombstones).toHaveLength(MAX_REMOVED_REPO_ID_TOMBSTONES)
    expect(tombstones[0].repoId).toBe('repo-5')
  })
})
