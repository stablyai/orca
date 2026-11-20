import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { getDefaultPersistedState } from '../../../shared/orca-profiles/constants'
import { ORCA_PROFILE_INDEX_SCHEMA_VERSION } from '../../../shared/orca-profiles/orca-profiles'
import { createWorkerMaintenanceFixture } from '../../persistence/loading-store/profile-writing/profile-state-maintenance-fixture'
import { ProfileStateSqliteAuthority } from '../../persistence/profile-state/profile-state-sqlite-authority'
import { transferActiveProfileProject } from './profile-active-transfer'
import './profile-project-domain-state'
import './profile-project-move-intent'
import './profile-project-move-record'
import { readProfileStateWithRevision } from './profile-project-state-file'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../ssh/config/ssh-config-parser', () => ({
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
})
