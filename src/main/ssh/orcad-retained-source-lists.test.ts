import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../shared/project-group-types'
import type { Repo } from '../../shared/repo-types'
import type { SshTarget } from '../../shared/ssh-types'
import { isAdmissibleDirectSshAuthority } from '../../shared/ssh-retained-payload-admission'
import type { Store } from '../persistence'
import { orcadMigrationCutoverFixture } from './orcad-migration-cutover-fixture'
import { writeOrcadMigrationSourceCutover } from './orcad-migration-cutover-journal'

const userData = vi.hoisted(() => ({ dir: '' }))
vi.mock('../../shared/app-environment', () => ({
  getAppEnvironment: () => ({ getPath: () => userData.dir })
}))
vi.mock('./ssh-provider-authority', () => ({ isCurrentSshProviderAuthority: () => true }))
const provider = {}
vi.mock('../providers/ssh-git-dispatch', () => ({ getSshGitProvider: () => provider }))

const { isFrozenOrcadSourceSessionPartition, visibleProjectGroups } =
  await import('./orcad-retained-source')
const { listReposForExecutionHost } = await import('../ipc/repos/host-repo-catalog-snapshot')

const FENCED: SshTarget = {
  id: 'ssh-box',
  label: 'Box',
  host: 'box.example.com',
  port: 22,
  username: 'me',
  generation: 2,
  orcadFence: { environmentId: 'env-1' }
}

function group(id: string, connectionId: string | null): ProjectGroup {
  return {
    id,
    name: id,
    parentPath: '/srv',
    parentGroupId: null,
    connectionId,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1
  }
}

const sourceRepo: Repo = {
  id: 'repo-1',
  path: '/srv/app',
  displayName: 'App',
  badgeColor: '#737373',
  addedAt: 1,
  kind: 'git',
  connectionId: FENCED.id
}

function catalog(targets: SshTarget[]): Store {
  const groups = [group('source-group', FENCED.id), group('local-group', null)]
  const folders: FolderWorkspace[] = []
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the lists read only these four getters.
  return {
    getSshTargets: () => targets,
    getRepos: () => [sourceRepo],
    getProjectGroups: () => groups,
    getFolderWorkspaces: () => folders
  } as unknown as Store
}

describe('lists while a converted host keeps its source rows', () => {
  beforeEach(() => {
    userData.dir = mkdtempSync(join(tmpdir(), 'orcad-retained-lists-'))
    writeOrcadMigrationSourceCutover(userData.dir, {
      ...orcadMigrationCutoverFixture('m-0', FENCED.id),
      phase: 'destination-committed'
    })
  })
  afterEach(() => rmSync(userData.dir, { recursive: true, force: true }))

  it('shows every row of a fenced host no journal explains, as after an empty-host deploy', () => {
    const emptyDeploy = mkdtempSync(join(tmpdir(), 'orcad-retained-lists-'))
    try {
      // An older build added these after the deploy; no move owns them, so they stay visible.
      expect(visibleProjectGroups(catalog([FENCED]), () => emptyDeploy)).toHaveLength(2)
    } finally {
      rmSync(emptyDeploy, { recursive: true, force: true })
    }
  })

  it('hides the host own project groups, but not a local group', () => {
    expect(visibleProjectGroups(catalog([FENCED])).map((entry) => entry.id)).toEqual([
      'local-group'
    ])
  })

  it('shows them again once an older build changed the host', () => {
    const changed = { ...FENCED, orcadFence: { environmentId: 'env-1', sourceChangedAt: 'x' } }
    expect(visibleProjectGroups(catalog([changed])).map((entry) => entry.id)).toEqual([
      'source-group',
      'local-group'
    ])
  })

  it('shows them until the migration commits, while freezing the session from the fence on', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orcad-retained-lists-'))
    try {
      const cutover = orcadMigrationCutoverFixture('m-1', FENCED.id)
      writeOrcadMigrationSourceCutover(userDataPath, cutover)
      const store = catalog([FENCED])
      const lookup = { getSshTarget: () => FENCED }
      expect(visibleProjectGroups(store, () => userDataPath)).toHaveLength(2)
      expect(isFrozenOrcadSourceSessionPartition(lookup, 'ssh:ssh-box')).toBe(true)
      writeOrcadMigrationSourceCutover(userDataPath, { ...cutover, phase: 'destination-committed' })
      expect(visibleProjectGroups(store, () => userDataPath)).toHaveLength(1)
      expect(isFrozenOrcadSourceSessionPartition(lookup, 'local')).toBe(false)
      const changed = { ...FENCED, orcadFence: { environmentId: 'env-1', sourceChangedAt: 'x' } }
      expect(
        isFrozenOrcadSourceSessionPartition({ getSshTarget: () => changed }, 'ssh:ssh-box')
      ).toBe(false)
    } finally {
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })

  it('leaves the source repos out of the host catalog the SSH bridge hydrates from', async () => {
    const authority: unknown = { targetId: FENCED.id, providerEpoch: 'e1', connectionGeneration: 1 }
    if (!isAdmissibleDirectSshAuthority(authority)) {
      throw new Error('fixture authority rejected')
    }
    const snapshot = await listReposForExecutionHost(catalog([FENCED]), {
      executionHostId: `ssh:${FENCED.id}`,
      expectedAuthority: authority
    })
    expect(snapshot).toMatchObject({ authoritative: true, repos: [] })
  })
})
