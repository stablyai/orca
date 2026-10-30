import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultPersistedState } from '../../../shared/constants'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { ProjectGroup } from '../../../shared/project-group-types'
import type { Repo } from '../../../shared/repo-types'
import { WSL_HOSTS_INTERNAL_GATE_ENV } from '../../../shared/wsl-host-internal-gate'
import type { Store } from '../../persistence'
import {
  closeTestStores,
  createStore,
  makeRepo,
  readPersistedStateJson,
  testState,
  writeDataFile
} from '../persistence-test-harness'
import { visibleFolderWorkspaces, visibleRepos } from '../../ssh/orcad-retained-source'
import { wslMoveCutoverFixture } from '../__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { seedWslMoveCutover } from '../__fixtures__/wsl-mover/wsl-move-journal-seeding'
import {
  listWslMoveCutovers,
  removeWslMoveCutover,
  wslMoveJournalDirectory
} from './wsl-move-cutover-journal'
import { planWslMove } from './wsl-move-delta-plan'
import { installWslMoveRetention, runWslMoveRetentionPass } from './wsl-move-retention'
import { loadWslMoveFence, resetWslMoveFenceForTests } from './wsl-move-scope-guard'
import { bringWslMovedProjectBack } from './wsl-move-use-locally'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))

const UNC = '\\\\wsl.localhost\\Ubuntu'
const NOW = new Date('2026-10-20T00:00:00.000Z')
const MARK = { migrationId: 'move-1', environmentId: 'wsl:Ubuntu' }

const group: ProjectGroup = {
  id: 'group',
  name: 'Ubuntu folders',
  parentPath: `${UNC}\\srv`,
  connectionId: null,
  parentGroupId: null,
  createdFrom: 'manual',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 0,
  updatedAt: 0
}

function folder(id: string, folderPath: string, connectionId: string | null = null) {
  return {
    id,
    projectGroupId: 'group',
    name: id,
    folderPath,
    connectionId,
    linkedTask: null,
    comment: 'kept',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdAt: 0,
    updatedAt: 0
  } satisfies FolderWorkspace
}

const movedRepo = makeRepo({
  id: 'repo-a',
  displayName: 'repo-a',
  path: `${UNC}\\home\\dev\\repo-a`,
  worktreeBaseRef: 'origin/main'
})
const stayingRepo = makeRepo({ id: 'repo-w', displayName: 'Windows', path: 'C:\\src\\w' })
const sshRepo = makeRepo({ id: 'repo-a', displayName: 'remote', path: '/r', connectionId: 'ssh-1' })

function profile(overrides: Partial<PersistedState> = {}): PersistedState {
  return {
    ...getDefaultPersistedState(testState.dir),
    repos: [movedRepo, stayingRepo, sshRepo],
    projectGroups: [group],
    folderWorkspaces: [folder('notes', `${UNC}\\srv\\notes`), folder('remote', '/srv/r', 'ssh-1')],
    ...overrides
  }
}

function persisted(): PersistedState {
  return JSON.parse(readPersistedStateJson())
}

const retainedMove = (phase: 'client-rewritten' | 'retained' = 'client-rewritten') =>
  wslMoveCutoverFixture('move-1', phase, {}, { repoIds: ['repo-a'], folderWorkspaceIds: ['notes'] })

const localRow = <T extends { connectionId?: string | null }>(rows: T[]): T[] =>
  rows.filter((row) => !row.connectionId)

let store: Store
function open(state: PersistedState): Store {
  writeDataFile(state)
  store = createStore()
  loadWslMoveFence(testState.dir)
  return store
}
const pass = () =>
  runWslMoveRetentionPass({ userDataPath: testState.dir, store, now: () => NOW, warn: () => {} })

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'wsl-move-retention-'))
  vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '1')
})
afterEach(async () => {
  vi.unstubAllEnvs()
  resetWslMoveFenceForTests()
  await closeTestStores()
  rmSync(testState.dir, { recursive: true, force: true })
})

describe('WSL move retention', () => {
  it('marks the source rows durably, then retains the move; nothing is deleted', async () => {
    seedWslMoveCutover(testState.dir, retainedMove())
    open(profile())

    const report = await pass()

    expect(report).toEqual({ retainedMigrationIds: ['move-1'], rewrittenMarks: 2, changed: [] })
    expect(listWslMoveCutovers(testState.dir)[0]?.phase).toBe('retained')
    const saved = persisted()
    expect(saved.repos).toHaveLength(3)
    expect(localRow(saved.repos).find((repo) => repo.id === 'repo-a')).toEqual({
      ...movedRepo,
      orcadRetained: MARK
    })
    expect(saved.folderWorkspaces?.find((row) => row.id === 'notes')?.orcadRetained).toEqual(MARK)
    // The SSH rows sharing an id, and the Windows project, are never marked.
    expect(saved.repos.find((repo) => repo.connectionId === 'ssh-1')?.orcadRetained).toBeUndefined()
    expect(saved.repos.find((repo) => repo.id === 'repo-w')?.orcadRetained).toBeUndefined()
    expect(
      saved.folderWorkspaces?.find((row) => row.id === 'remote')?.orcadRetained
    ).toBeUndefined()
    // Hidden by the same lists SSH uses.
    const userData = () => testState.dir
    expect(
      visibleRepos(store, userData).map((repo) => [repo.id, repo.connectionId ?? null])
    ).toEqual([
      ['repo-w', null],
      ['repo-a', 'ssh-1']
    ])
    expect(visibleFolderWorkspaces(store, userData).map((row) => row.id)).toEqual(['remote'])
  })

  it('downgrade then re-upgrade: re-hides, re-marks, flags the edit and loses no row', async () => {
    seedWslMoveCutover(testState.dir, retainedMove())
    open(profile())
    await pass()
    await closeTestStores()
    resetWslMoveFenceForTests()

    // An older build: it never reads the WSL journal, strips the marks it does not know, and the
    // user renames the moved project and adds a new one in the same distro.
    const downgraded = persisted()
    const strip = <T extends { orcadRetained?: unknown }>({
      orcadRetained: _stripped,
      ...row
    }: T) => row
    const added = makeRepo({ id: 'repo-b', displayName: 'repo-b', path: `${UNC}\\home\\dev\\b` })
    const rows = downgraded.repos
      .map(strip)
      .map((repo) =>
        repo.id === 'repo-a' && !repo.connectionId ? { ...repo, displayName: 'renamed' } : repo
      )
    open({
      ...downgraded,
      repos: [...rows, added],
      folderWorkspaces: downgraded.folderWorkspaces?.map(strip)
    })
    expect(store.getRepos().some((repo) => repo.orcadRetained)).toBe(false)

    const report = await pass()

    expect(report).toEqual({
      retainedMigrationIds: [],
      rewrittenMarks: 2,
      changed: [{ kind: 'repo', id: 'repo-a' }]
    })
    const saved = persisted()
    const local = localRow(saved.repos)
    expect(local.find((repo) => repo.id === 'repo-a')).toEqual({
      ...movedRepo,
      displayName: 'renamed',
      orcadRetained: { ...MARK, sourceChangedAt: NOW.toISOString() }
    })
    expect(saved.folderWorkspaces?.find((row) => row.id === 'notes')).toMatchObject({
      comment: 'kept',
      orcadRetained: MARK
    })
    expect(local.map((repo) => repo.id).sort()).toEqual(['repo-a', 'repo-b', 'repo-w'])
    expect(
      visibleRepos(store, () => testState.dir)
        .filter((repo) => !repo.connectionId)
        .map((repo) => repo.id)
        .sort()
    ).toEqual(['repo-b', 'repo-w'])
    // Offered, never run: the edit is listed and only the new project would move.
    const planned = planWslMove(
      testState.dir,
      {
        repos: store.getRepos(),
        folderWorkspaces: store.getFolderWorkspaces(),
        projectGroups: store.getProjectGroups()
      },
      'Ubuntu',
      { repoIds: ['repo-a'], folderWorkspaceIds: ['notes'], highestGeneration: 1 }
    )
    expect(planned).toMatchObject({
      outcome: 'ready',
      plan: { repoIds: ['repo-b'], changed: [{ kind: 'repo', id: 'repo-a' }] }
    })
    expect(listWslMoveCutovers(testState.dir).map((entry) => entry.migrationId)).toEqual(['move-1'])

    // A later start keeps the first time it saw the change.
    const again = await runWslMoveRetentionPass({
      userDataPath: testState.dir,
      store,
      now: () => new Date('2026-11-01T00:00:00.000Z')
    })
    expect(again?.rewrittenMarks).toBe(0)
  })

  it('drops the marks once the move is dropped, so the rows list again', async () => {
    seedWslMoveCutover(testState.dir, retainedMove())
    open(profile())
    await pass()

    expect(bringWslMovedProjectBack(testState.dir, { repoId: 'repo-a' }).released).toBe(true)
    const report = await pass()

    expect(report?.rewrittenMarks).toBe(2)
    expect(store.getRepos().some((repo) => repo.orcadRetained)).toBe(false)
    expect(store.getFolderWorkspaces().some((row) => row.orcadRetained)).toBe(false)
    expect(visibleRepos(store, () => testState.dir)).toHaveLength(3)
  })

  it('changes nothing with no journal: SSH and folder workspaces untouched', async () => {
    open(profile())
    const before = persisted()

    expect(await pass()).toEqual({ retainedMigrationIds: [], rewrittenMarks: 0, changed: [] })

    expect(persisted().repos).toEqual(before.repos)
    expect(persisted().folderWorkspaces).toEqual(before.folderWorkspaces)
    expect(visibleRepos(store, () => testState.dir)).toHaveLength(3)
    expect(visibleFolderWorkspaces(store, () => testState.dir)).toHaveLength(2)
  })

  it('keeps every mark when the journal cannot be read', async () => {
    seedWslMoveCutover(testState.dir, retainedMove())
    open(profile())
    await pass()
    const dir = wslMoveJournalDirectory(testState.dir)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'broken.json'), '{')

    expect(await pass()).toBeNull()
    expect(localRow(store.getRepos()).find((repo) => repo.id === 'repo-a')?.orcadRetained).toEqual(
      MARK
    )
  })

  it('does nothing with the internal WSL hosts gate closed', async () => {
    vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '')
    seedWslMoveCutover(testState.dir, retainedMove())
    open(profile())

    expect(await pass()).toBeNull()
    expect(listWslMoveCutovers(testState.dir)[0]?.phase).toBe('client-rewritten')
    expect(store.getRepos().some((repo: Repo) => repo.orcadRetained)).toBe(false)
  })

  it('marks a delta move with its own id and keeps the earlier move on its rows', async () => {
    seedWslMoveCutover(testState.dir, retainedMove('retained'))
    open(profile())
    await pass()
    seedWslMoveCutover(
      testState.dir,
      wslMoveCutoverFixture(
        'move-2',
        'client-rewritten',
        { supersedesMigrationId: 'move-1' },
        { repoIds: ['repo-z'] }
      )
    )
    store.addRepo(
      makeRepo({ id: 'repo-z', displayName: 'repo-z', path: `${UNC}\\home\\dev\\repo-z` })
    )

    expect((await pass())?.retainedMigrationIds).toEqual(['move-2'])

    const marks = localRow(store.getRepos()).map((repo) => [
      repo.id,
      repo.orcadRetained?.migrationId
    ])
    expect(marks).toEqual(
      expect.arrayContaining([
        ['repo-a', 'move-1'],
        ['repo-z', 'move-2']
      ])
    )
  })

  it('leaves the move unretained when its marks cannot be made durable', async () => {
    seedWslMoveCutover(testState.dir, retainedMove())
    open(profile())
    const failing = {
      getRepos: () => store.getRepos(),
      getFolderWorkspaces: () => store.getFolderWorkspaces(),
      setWslMoveRetainedMarks: (marks: Parameters<Store['setWslMoveRetainedMarks']>[0]) =>
        store.setWslMoveRetainedMarks(marks),
      flushPendingOrThrowAsync: () => Promise.reject(new Error('disk full'))
    }

    expect(
      await runWslMoveRetentionPass({ userDataPath: testState.dir, store: failing, warn: () => {} })
    ).toBeNull()
    expect(listWslMoveCutovers(testState.dir)[0]?.phase).toBe('client-rewritten')
  })

  it('retains a move as soon as the journal says its rewrite finished', async () => {
    open(profile())
    const stop = installWslMoveRetention({ userDataPath: testState.dir, store, warn: () => {} })
    try {
      seedWslMoveCutover(testState.dir, retainedMove())
      await vi.waitFor(() => {
        expect(listWslMoveCutovers(testState.dir)[0]?.phase).toBe('retained')
      })
      expect(
        localRow(store.getRepos()).find((repo) => repo.id === 'repo-a')?.orcadRetained
      ).toEqual(MARK)
    } finally {
      stop()
    }
  })

  it('keeps every mark when a release is refused because a later move builds on it', async () => {
    seedWslMoveCutover(testState.dir, retainedMove('retained'))
    seedWslMoveCutover(
      testState.dir,
      wslMoveCutoverFixture(
        'move-2',
        'retained',
        { supersedesMigrationId: 'move-1' },
        { repoIds: ['repo-z'] }
      )
    )
    open(profile())
    await pass()

    expect(() => removeWslMoveCutover(testState.dir, 'move-1')).toThrow('wsl_move_superseded')
    expect((await pass())?.rewrittenMarks).toBe(0)
    expect(localRow(store.getRepos()).find((repo) => repo.id === 'repo-a')?.orcadRetained).toEqual(
      MARK
    )
  })

  it('drops a mark naming a move that never took the row', async () => {
    seedWslMoveCutover(testState.dir, retainedMove('retained'))
    open(profile({ repos: [movedRepo, { ...stayingRepo, orcadRetained: MARK }] }))

    await pass()

    expect(store.getRepos().find((repo) => repo.id === 'repo-w')?.orcadRetained).toBeUndefined()
  })
})
