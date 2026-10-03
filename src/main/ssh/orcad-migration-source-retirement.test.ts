import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SshTarget } from '../../shared/ssh-types'
import { closeTestStores, createSqliteTestStore } from '../persistence-test-harness'
import { Store } from '../persistence/loading-store/store'
import { commitOrcadMigrationDestination } from './orcad-migration-cutover-coordinator'
import {
  listOrcadMigrationSourceCutovers,
  writeOrcadMigrationSourceCutover
} from './orcad-migration-cutover-journal'
import { fakeOrcadMigrationDestination } from './orcad-migration-destination-fake'
import { fenceOrcadMigrationSource } from './orcad-migration-source-fence'
import { retireOrcadMigrationSource } from './orcad-migration-source-retirement'
import { SshTargetOrcadClaims } from './ssh-target-orcad-claims'

const TARGET: SshTarget = {
  id: 'ssh-prod',
  label: 'Production',
  host: 'prod.example.com',
  port: 22,
  username: 'deploy',
  generation: 2
}

const directories: string[] = []
afterEach(async () => {
  await closeTestStores()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

async function setup(options: { commit?: boolean; localRepoInGroup?: boolean } = {}) {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orcad-source-retirement-'))
  directories.push(userDataPath)
  const store = createSqliteTestStore(Store, { dataFile: join(userDataPath, 'orca-data.json') })
  store.addSshTarget(TARGET)
  const group = store.createProjectGroup({
    name: 'Prod',
    parentPath: '/srv',
    createdFrom: 'folder-scan',
    connectionId: TARGET.id
  })
  store.addRepo({
    id: 'repo-1',
    path: '/srv/app',
    displayName: 'App',
    badgeColor: '#737373',
    addedAt: 1,
    kind: 'git',
    connectionId: TARGET.id,
    projectGroupId: group.id
  })
  store.createFolderWorkspace({
    projectGroupId: group.id,
    name: 'Scratch',
    folderPath: '/srv/scratch',
    connectionId: TARGET.id
  })
  if (options.localRepoInGroup) {
    store.addRepo({
      id: 'repo-local',
      path: '/home/me/local',
      displayName: 'Local',
      badgeColor: '#737373',
      addedAt: 2,
      kind: 'git',
      projectGroupId: group.id
    })
  }
  store.upsertSshRemotePtyLease({ targetId: TARGET.id, ptyId: 'old', state: 'terminated' })
  const claims = new SshTargetOrcadClaims(store)
  const fenced = await fenceOrcadMigrationSource({
    userDataPath,
    store,
    claims,
    targetId: TARGET.id,
    destinationEnvironmentId: 'env-1',
    destinationName: 'Managed',
    terminalProof: { verdict: 'exited', provenPtyIds: ['old'] },
    hasDirectSshAuthority: () => false
  })
  if (fenced.outcome !== 'fenced') {
    throw new Error(`expected a fence: ${JSON.stringify(fenced)}`)
  }
  if (options.commit !== false) {
    await commitOrcadMigrationDestination(
      { userDataPath, store, claims, destination: fakeOrcadMigrationDestination() },
      fenced.cutover.migrationId
    )
  }
  const retire = () =>
    retireOrcadMigrationSource(
      { userDataPath, store, environment: null },
      fenced.cutover.migrationId
    )
  return { userDataPath, store, retire, migrationId: fenced.cutover.migrationId, groupId: group.id }
}

describe('retiring a migrated source', () => {
  it('removes the migrated rows, folder workspaces and proven leases, then marks the journal', async () => {
    const h = await setup()
    // The renderer may still be writing the reconnect hint for the released session.
    h.store.patchWorkspaceSession({ activeConnectionIdsAtShutdown: [TARGET.id, 'ssh-other'] })
    await expect(h.retire()).resolves.toMatchObject({ phase: 'source-retired' })
    expect(h.store.getRepos()).toEqual([])
    expect(h.store.getFolderWorkspaces()).toEqual([])
    expect(h.store.getProjectGroups()).toEqual([])
    expect(h.store.getSshRemotePtyLeases(TARGET.id)).toEqual([])
    // The target stays: it carries the managed server's tunnel now.
    expect(h.store.getSshTarget(TARGET.id)).toBeDefined()
    expect(h.store.getWorkspaceSession().activeConnectionIdsAtShutdown).toEqual(['ssh-other'])
  })

  it('refuses to retire anything before the destination proved its commit', async () => {
    const h = await setup({ commit: false })
    await expect(h.retire()).rejects.toThrow('orcad_migration_retire_before_commit')
    expect(h.store.getRepos().map((repo) => repo.id)).toEqual(['repo-1'])
  })

  it('refuses when the fence that authorized the migration is gone', async () => {
    const h = await setup()
    h.store.updateSshTarget(TARGET.id, { orcadFence: undefined })
    await expect(h.retire()).rejects.toThrow('orcad_migration_source_fence_lost')
    expect(h.store.getRepos().map((repo) => repo.id)).toEqual(['repo-1'])
  })

  it('finishes the same work after a crash between the profile flush and the journal write', async () => {
    const h = await setup()
    const [committed] = listOrcadMigrationSourceCutovers(h.userDataPath)
    await h.retire()
    writeOrcadMigrationSourceCutover(h.userDataPath, committed!)
    await expect(h.retire()).resolves.toMatchObject({ phase: 'source-retired' })
    expect(h.store.getRepos()).toEqual([])
  })

  it('keeps a group that something outside the migration still uses', async () => {
    const h = await setup({ localRepoInGroup: true })
    await h.retire()
    expect(h.store.getRepos().map((repo) => repo.id)).toEqual(['repo-local'])
    expect(h.store.getProjectGroups().map((group) => group.id)).toEqual([h.groupId])
    expect(h.store.getFolderWorkspaces()).toEqual([])
  })
})
