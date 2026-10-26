import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../shared/project-group-types'
import type { ProjectHostSetup } from '../../shared/project-types'
import type { Repo } from '../../shared/repo-types'
import type { SshTarget } from '../../shared/ssh-types'
import type { Store } from '../persistence'
import { orcadMigrationCutoverFixture } from './orcad-migration-cutover-fixture'
import { writeOrcadMigrationSourceCutover } from './orcad-migration-cutover-journal'
import { wslMoveCutoverFixture } from '../persistence/__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { seedWslMoveCutover } from '../persistence/__fixtures__/wsl-mover/wsl-move-journal-seeding'
import {
  loadWslMoveFence,
  resetWslMoveFenceForTests
} from '../persistence/moving-wsl-projects/wsl-move-scope-guard'

const userData = vi.hoisted(() => ({ dir: '' }))
vi.mock('../../shared/app-environment', () => ({
  getAppEnvironment: () => ({ getPath: () => userData.dir })
}))

const { isFrozenOrcadSourceSessionPartition, visibleProjectGroups, visibleProjectHostSetups } =
  await import('./orcad-retained-source')

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
})

function setup(id: string, hostId: ExecutionHostId, repoId: string): ProjectHostSetup {
  return {
    id,
    projectId: 'github:acme/app',
    hostId,
    repoId,
    path: '/srv/app',
    displayName: 'App',
    setupState: repoId ? 'ready' : 'not-set-up',
    setupMethod: 'legacy-repo',
    createdAt: 1,
    updatedAt: 1
  }
}

describe('project host setups of a converted host', () => {
  const localRepo: Repo = { ...sourceRepo, id: 'repo-local', path: '/work/app' }
  delete localRepo.connectionId
  const setups = [
    setup('repo-1', 'ssh:ssh-box', 'repo-1'),
    setup('placeholder', 'ssh:ssh-box', ''),
    setup('repo-local', 'local', 'repo-local')
  ]
  type SetupCatalog = Parameters<typeof visibleProjectHostSetups>[0]
  const catalogOf = (targets: SshTarget[], repos: Repo[], rows = setups): SetupCatalog => ({
    getSshTargets: () => targets,
    getRepos: () => repos,
    getProjectGroups: () => [],
    getFolderWorkspaces: () => [],
    getProjectHostSetups: () => rows
  })
  const store = (targets: SshTarget[]): SetupCatalog => catalogOf(targets, [sourceRepo, localRepo])
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orcad-retained-setups-'))
    userData.dir = dir
    writeOrcadMigrationSourceCutover(dir, {
      ...orcadMigrationCutoverFixture('m-0', FENCED.id),
      phase: 'destination-committed'
    })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  // #30859: retained setup rows duplicated the server's same-id host setups.
  it('hides the setups the hidden source rows own, and keeps local ones', () => {
    expect(visibleProjectHostSetups(store([FENCED])).map((entry) => entry.id)).toEqual([
      'repo-local'
    ])
  })

  it('hides a folder-only host placeholder even when no repo row is hidden', () => {
    const folderOnly = catalogOf([FENCED], [localRepo], setups.slice(1))
    expect(visibleProjectHostSetups(folderOnly).map((entry) => entry.id)).toEqual(['repo-local'])
  })

  it('hides the local setup of a project a WSL move took, by its repo row alone', () => {
    loadWslMoveFence(dir)
    try {
      seedWslMoveCutover(
        dir,
        wslMoveCutoverFixture('move-1', 'destination-committed', {}, { repoIds: ['repo-local'] })
      )
      // No SSH host is fenced here, so only the repo-row match can drop the setup.
      expect(visibleProjectHostSetups(store([])).map((entry) => entry.id)).toEqual([
        'repo-1',
        'placeholder'
      ])
    } finally {
      resetWslMoveFenceForTests()
    }
  })

  it('lists them again once an older build changed the host', () => {
    const changed = { ...FENCED, orcadFence: { environmentId: 'env-1', sourceChangedAt: 'x' } }
    expect(visibleProjectHostSetups(store([changed]))).toHaveLength(3)
  })
})
