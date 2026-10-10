import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { githubAvatarIcon } from '../shared/repo-icon'
import { manifest, REPOSITORY } from './persistence-orcad-migration-catalog-fixture'
import { closeTestStores, createStore, testState } from './persistence-test-harness'

vi.mock('./telemetry/client', () => ({ track: vi.fn() }))
vi.mock('./telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({ nth_repo_added: 1 }) }))

const remoteIdentity = {
  canonicalKey: 'github.com/example/project',
  remoteName: 'origin',
  remoteUrl: 'https://github.com/example/project.git'
}

function commit(store: ReturnType<typeof createStore>, input: ReturnType<typeof manifest>) {
  store.stageOrcadMigrationCatalog(input)
  return store.commitStagedOrcadMigrationCatalog(input)
}

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-migration-cache-'))
})
afterEach(async () => {
  await closeTestStores()
  rmSync(testState.dir, { recursive: true, force: true })
})

describe('reimporting a repository after the destination resolves its Git identity', () => {
  it.each([null, remoteIdentity])(
    'keeps the destination cache after restart (%j)',
    async (identity) => {
      const store = createStore()
      commit(store, manifest())
      store.updateRepo(REPOSITORY.id, { gitRemoteIdentity: identity })
      await store.flushPendingOrThrowAsync()
      await closeTestStores()
      const restored = createStore()

      expect(commit(restored, manifest({ migrationId: 'migration-redeploy' }))).toMatchObject({
        state: 'committed'
      })
      expect(restored.getRepos()).toHaveLength(1)
      expect(restored.getRepos()[0]?.gitRemoteIdentity).toEqual(identity)
    }
  )

  it('preserves the current cache when the incoming cache is stale', () => {
    const store = createStore()
    commit(store, manifest())
    store.updateRepo(REPOSITORY.id, { gitRemoteIdentity: remoteIdentity })
    const next = manifest({
      migrationId: 'migration-stale-cache',
      payload: { ...manifest().payload, repositories: [{ ...REPOSITORY, gitRemoteIdentity: null }] }
    })
    expect(commit(store, next)).toMatchObject({ state: 'committed' })
    expect(store.getRepos()[0]?.gitRemoteIdentity).toEqual(remoteIdentity)
  })

  it.each([{ displayName: 'Changed' }, { path: '/different' }, { worktreeBaseRef: 'release' }])(
    'still refuses changed repository configuration (%j)',
    (changes) => {
      const store = createStore()
      commit(store, manifest())
      store.updateRepo(REPOSITORY.id, { gitRemoteIdentity: remoteIdentity })
      const next = manifest({
        migrationId: 'migration-conflict',
        payload: { ...manifest().payload, repositories: [{ ...REPOSITORY, ...changes }] }
      })
      expect(() => commit(store, next)).toThrow(
        `orcad_migration_repository_id_conflict:${REPOSITORY.id}`
      )
      expect(store.getRepos()).toHaveLength(1)
      expect(store.getRepos()[0]?.displayName).toBe(REPOSITORY.displayName)
      expect(store.getRepos()[0]?.path).toBe(REPOSITORY.path)
      expect(store.getRepos()[0]?.gitRemoteIdentity).toEqual(remoteIdentity)
      expect(store.getOrcadMigrationCatalogState(next).state).toBe('absent')
    }
  )
  it('keeps the destination identity and automatic avatar after the remote is renamed', () => {
    const oldIcon = githubAvatarIcon({ owner: 'old', repo: 'project' })
    const newIcon = githubAvatarIcon({ owner: 'example', repo: 'project' })
    const source = {
      ...REPOSITORY,
      repoIcon: oldIcon,
      gitRemoteIdentity: { ...remoteIdentity, canonicalKey: 'github.com/old/project' }
    }
    const withSource = (migrationId: string) =>
      manifest({ migrationId, payload: { ...manifest().payload, repositories: [source] } })
    const store = createStore()
    commit(store, withSource('m1'))
    store.updateRepo(REPOSITORY.id, { gitRemoteIdentity: remoteIdentity, repoIcon: newIcon })

    expect(commit(store, withSource('m2'))).toMatchObject({ state: 'committed' })
    expect(store.getRepos()[0]).toMatchObject({
      gitRemoteIdentity: remoteIdentity,
      repoIcon: newIcon
    })
  })

  it('still refuses a changed icon the user chose', () => {
    const store = createStore()
    commit(store, manifest())
    store.updateRepo(REPOSITORY.id, {
      repoIcon: githubAvatarIcon({ owner: 'example', repo: 'project' })
    })
    const next = manifest({
      migrationId: 'migration-user-icon',
      payload: {
        ...manifest().payload,
        repositories: [
          {
            ...REPOSITORY,
            repoIcon: { type: 'image', src: 'data:image/png;base64,AA==', source: 'upload' }
          }
        ]
      }
    })
    expect(() => commit(store, next)).toThrow(
      `orcad_migration_repository_id_conflict:${REPOSITORY.id}`
    )
  })
})
