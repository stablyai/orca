import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { getDefaultPersistedState } from '../../shared/constants'
import { ORCA_PROFILE_INDEX_SCHEMA_VERSION } from '../../shared/orca-profiles'
import { createWorkerMaintenanceFixture } from '../persistence/loading-store/profile-state-maintenance-fixture'
import { ProfileStateSqliteAuthority } from '../persistence/profile-state/profile-state-sqlite-authority'
import { transferActiveProfileProject } from './profile-active-transfer'
import * as domainState from './profile-project-domain-state'
import {
  profileHasPendingProjectMove,
  recoverPendingProfileProjectMoves
} from './profile-project-move-intent'
import { readProfileStateWithRevision } from './profile-project-state-file'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../ssh/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'orca-worker-profile-transfer-'))
  writeFileSync(
    join(root, 'orca-profile-index.json'),
    JSON.stringify({
      schemaVersion: ORCA_PROFILE_INDEX_SCHEMA_VERSION,
      activeProfileId: 'source',
      profiles: ['source', 'target'].map((id) => ({
        id,
        name: id,
        avatar: { kind: 'initials', initials: id[0], color: 'neutral' },
        kind: 'local',
        createdAt: 1,
        updatedAt: 1,
        lastOpenedAt: 1
      }))
    })
  )
  const current = await createWorkerMaintenanceFixture({
    directory: join(root, 'profiles', 'source'),
    profileId: 'source',
    cleanupRoot: root
  })
  const target = new ProfileStateSqliteAuthority(
    join(root, 'profiles', 'target', 'profile-state.db'),
    'target'
  )
  try {
    target.writeSerializedState(Buffer.from(JSON.stringify(getDefaultPersistedState(root))))
  } finally {
    target.close()
  }
  const args = {
    sourceProfileId: 'source',
    targetProfileId: 'target',
    repoId: 'repo-remote',
    mode: 'move'
  } as const
  const read = (id: string) => readProfileStateWithRevision(id, root)
  return { ...current, root, args, read }
}

describe('active profile transfers with the live writer', () => {
  it('resumes the exact source revision after a validation failure', async () => {
    const { store, root, args, read } = await fixture()
    const reopen = vi.fn(async () => {})
    await expect(
      transferActiveProfileProject({ ...args, repoId: 'missing' }, root, store, reopen)
    ).rejects.toThrow('unknown_source_repo')
    expect(reopen).not.toHaveBeenCalled()
    store.updateSettings({ theme: 'dark' })
    await store.flushPendingOrThrowAsync()
    expect(read('source').state.settings.theme).toBe('dark')
  })

  it('keeps the source frozen after moving a remote project and its persisted state', async () => {
    const { store, root, args, read } = await fixture()
    const result = await transferActiveProfileProject(args, root, store, async () => {})
    expect(result.status).toBe('transferred')
    expect(read('source').state.repos.some((repo) => repo.id === args.repoId)).toBe(false)
    expect(read('target').state.repos.some((repo) => repo.id === args.repoId)).toBe(true)
    const source = read('source')
    store.updateSettings({ theme: 'dark' })
    await expect(store.flushPendingOrThrowAsync()).rejects.toThrow('finalized')
    expect(read('source')).toEqual(source)
  })

  it('resumes when a copy makes a later move a duplicate', async () => {
    const { store, root, args, read } = await fixture()
    await transferActiveProfileProject({ ...args, mode: 'copy' }, root, store, async () => {})
    const result = await transferActiveProfileProject(args, root, store, async () => {})
    expect(result.status).toBe('duplicate-target')
    store.updateSettings({ theme: 'dark' })
    await store.flushPendingOrThrowAsync()
    expect(read('source').state.settings.theme).toBe('dark')
    expect(read('source').state.repos.some((repo) => repo.id === args.repoId)).toBe(true)
  })

  it('leaves an interrupted move frozen until journal recovery runs with the writer closed', async () => {
    const { store, root, args, read } = await fixture()
    const original = domainState.writeProfileProjectDomainChanges
    const fault = vi
      .spyOn(domainState, 'writeProfileProjectDomainChanges')
      .mockImplementation((id, ...rest) => {
        if (id === args.sourceProfileId) {
          throw new Error('source commit interrupted')
        }
        return original(id, ...rest)
      })
    const reopen = vi.fn(async () => {})
    await expect(transferActiveProfileProject(args, root, store, reopen)).rejects.toThrow(
      'source commit interrupted'
    )
    expect(reopen).toHaveBeenCalledOnce()
    expect(profileHasPendingProjectMove('source', root)).toBe(true)
    await expect(store.flushPendingOrThrowAsync()).rejects.toThrow('finalized')
    fault.mockRestore()
    expect(recoverPendingProfileProjectMoves(root)).toBe(1)
    expect(read('source').state.repos.some((repo) => repo.id === args.repoId)).toBe(false)
    expect(read('target').state.repos.some((repo) => repo.id === args.repoId)).toBe(true)
  })
})
