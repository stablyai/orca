import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import type { SshTarget } from '../../shared/ssh-types'
import { closeTestStores, createSqliteTestStore } from '../persistence/persistence-test-harness'
import { Store } from '../persistence/loading-store/store'
import { SshConnectionStore } from './connection/ssh-connection-store'
import { orcadMigrationCutoverFixture } from './orcad-migration-cutover-fixture'
import {
  findOrcadMigrationSourceCutoverForTarget,
  writeOrcadMigrationSourceCutover
} from './orcad-migration-cutover-journal'
import { keepOrcadServerVersion } from './orcad-migration-delta-move'
import { createOrcadMigrationManifest } from './orcad-migration-manifest-export'
import {
  currentOrcadSourceFingerprint,
  reconcileManagedOrcadSshTargets,
  visibleRepos
} from './orcad-retained-source'

const TARGET: SshTarget = {
  id: 'ssh-prod',
  label: 'Production',
  host: 'prod.example.com',
  port: 22,
  username: 'deploy',
  generation: 2
}
const FENCE = { environmentId: 'env-1' }
const now = () => new Date('2026-10-22T00:00:00.000Z')

let userDataPath: string
let store: Store

function repo(id: string, path: string): Repo {
  return {
    id,
    path,
    displayName: id,
    badgeColor: '#737373',
    addedAt: 1,
    kind: 'git',
    connectionId: TARGET.id
  }
}

/** Commit the initial source manifest while retaining hidden desktop rows. */
function movedHost(): void {
  const manifest = createOrcadMigrationManifest(store, store.getSshTarget(TARGET.id)!, {
    migrationId: 'm-1',
    destinationEnvironmentId: FENCE.environmentId,
    now
  })
  writeOrcadMigrationSourceCutover(userDataPath, {
    ...orcadMigrationCutoverFixture('m-1', TARGET.id),
    phase: 'destination-committed',
    sourceRetainedAt: now().toISOString(),
    manifestSha256: manifest.manifestSha256,
    manifest
  })
  store.updateSshTarget(TARGET.id, { orcadFence: FENCE })
}

const changedAt = () => store.getSshTarget(TARGET.id)?.orcadFence?.sourceChangedAt
const visibleIds = () => visibleRepos(store, () => userDataPath).map((row) => row.id)

beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'orcad-retained-changes-'))
  store = createSqliteTestStore(Store, { dataFile: join(userDataPath, 'orca-data.json') })
  store.addSshTarget(TARGET)
  store.addRepo(repo('repo-1', '/srv/app'))
  // A desktop group holding the host's project and a folder of it, which the move took along.
  const group = store.createProjectGroup({ name: 'work', createdFrom: 'manual' })
  store.moveProjectToGroup(store.getRepo('repo-1')!, group.id)
  store.createFolderWorkspace({
    projectGroupId: group.id,
    folderPath: '/srv/notes',
    connectionId: TARGET.id
  })
})

afterEach(async () => {
  await closeTestStores()
  rmSync(userDataPath, { recursive: true, force: true })
})

describe('what makes a moved host changed', () => {
  it('keeps the host served when its groups are deleted or created (#31523)', () => {
    movedHost()
    reconcileManagedOrcadSshTargets(userDataPath, store, now)
    expect(changedAt()).toBeUndefined()

    // Deleting the group also drops the folder workspace in it; the server keeps its own copy.
    store.deleteProjectGroup(store.getProjectGroups()[0]!.id)
    store.createProjectGroup({ name: 'later', connectionId: TARGET.id, createdFrom: 'manual' })
    reconcileManagedOrcadSshTargets(userDataPath, store, now)

    expect(changedAt()).toBeUndefined()
    expect(visibleIds()).toEqual([])
  })

  it('still marks a project no move took', () => {
    movedHost()
    store.addRepo(repo('repo-2', '/srv/tool'))
    reconcileManagedOrcadSshTargets(userDataPath, store, now)

    expect(changedAt()).toBeDefined()
    expect(visibleIds().sort()).toEqual(['repo-1', 'repo-2'])
  })

  it('lifts a mark an earlier build set for a group edit, but not one for an added project', () => {
    movedHost()
    store.deleteProjectGroup(store.getProjectGroups()[0]!.id)
    store.updateSshTarget(TARGET.id, { orcadFence: { ...FENCE, sourceChangedAt: 'earlier' } })
    reconcileManagedOrcadSshTargets(userDataPath, store, now)
    expect(changedAt()).toBeUndefined()
    expect(store.getSshTarget(TARGET.id)?.orcadFence).toEqual(FENCE)

    store.addRepo(repo('repo-2', '/srv/tool'))
    store.updateSshTarget(TARGET.id, { orcadFence: { ...FENCE, sourceChangedAt: 'earlier' } })
    reconcileManagedOrcadSshTargets(userDataPath, store, now)
    expect(changedAt()).toBe('earlier')
  })

  it('upgrades a server version an earlier build kept, so a later group edit is no change', () => {
    movedHost()
    store.addRepo(repo('repo-2', '/srv/tool'))
    // What an earlier build's "keep the server's version" wrote: a baseline, no list of kept rows.
    const head = findOrcadMigrationSourceCutoverForTarget(userDataPath, TARGET.id)!
    writeOrcadMigrationSourceCutover(userDataPath, {
      ...head,
      sourceBaselineFingerprint: currentOrcadSourceFingerprint(store, TARGET)
    })
    reconcileManagedOrcadSshTargets(userDataPath, store, now)
    expect(changedAt()).toBeUndefined()

    store.deleteProjectGroup(store.getProjectGroups()[0]!.id)
    reconcileManagedOrcadSshTargets(userDataPath, store, now)
    expect(changedAt()).toBeUndefined()
    store.addRepo(repo('repo-3', '/srv/docs'))
    reconcileManagedOrcadSshTargets(userDataPath, store, now)
    expect(changedAt()).toBeDefined()
  })

  it('keeps the server version so a later group edit is no change, and a new project is', async () => {
    movedHost()
    store.addRepo(repo('repo-2', '/srv/tool'))
    reconcileManagedOrcadSshTargets(userDataPath, store, now)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SshConnectionStore wraps the real test store it is given.
    const claims = new SshConnectionStore(store as never).getOrcadRuntimeClaims()
    await keepOrcadServerVersion({
      userDataPath,
      store,
      claims,
      target: store.getSshTarget(TARGET.id)!
    })
    expect(changedAt()).toBeUndefined()

    store.deleteProjectGroup(store.getProjectGroups()[0]!.id)
    reconcileManagedOrcadSshTargets(userDataPath, store, now)
    expect(changedAt()).toBeUndefined()
    store.addRepo(repo('repo-3', '/srv/docs'))
    reconcileManagedOrcadSshTargets(userDataPath, store, now)
    expect(changedAt()).toBeDefined()
  })
})
