import { mkdtemp, mkdir, symlink, rm, realpath } from 'node:fs/promises'
import { RUNTIME_CAPABILITIES } from '../../shared/protocol-version'
import { AI_VAULT_CANONICAL_PROJECT_SEARCH_CAPABILITY } from '../../shared/ai-vault-runtime-capabilities'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import { projectHostSetupCompatibilityFromRepos } from '../../shared/project-host-setup-projection'
import {
  compileSessionSearchProjectOwnership,
  sessionSearchProjectOwns
} from './session-search-project-ownership'
import { sessionSearchScopeCatalogFromStore } from './session-search-store-scope-catalog'
import {
  installSessionSearchScopeCatalogSource,
  resetSessionSearchScopeCatalogForTests
} from './session-search-scope-catalog'
import { createSessionSearchService } from './session-search-service'
import { createChildSessionSearchService } from './session-search-child-service'
import { searchSessionService, setSessionSearchService } from './session-search-service-registry'
import {
  openSessionSearchHarness,
  addSyntheticSession,
  markFork,
  type SessionSearchHarness
} from './session-search-engine-test-fixture'

const a: Repo = {
  id: 'a',
  displayName: 'app',
  path: '/repos/a',
  addedAt: 1,
  badgeColor: '',
  gitRemoteIdentity: {
    canonicalKey: 'example.org/team/app',
    remoteName: 'origin',
    remoteUrl: 'https://example.org/team/app.git'
  }
}
const b: Repo = { ...a, id: 'b', path: '/repos/b', addedAt: 2 }
let harness: SessionSearchHarness | undefined
afterEach(async () => {
  setSessionSearchService(null)
  resetSessionSearchScopeCatalogForTests()
  await harness?.close()
  harness = undefined
  vi.restoreAllMocks()
})

function store(repos = [a, b], provisioned: readonly string[] = []) {
  const projection = projectHostSetupCompatibilityFromRepos(repos)
  return {
    getRepos: () => repos,
    getProjects: () => projection.projects,
    getProjectHostSetups: () =>
      projection.setups.map((setup) =>
        provisioned.includes(setup.repoId)
          ? { ...setup, setupMethod: 'provisioned' as const }
          : setup
      ),
    getAllWorktreeMeta: () => ({
      'b::/linked/b': {
        displayName: '',
        comment: '',
        linkedIssue: null,
        linkedPR: null,
        linkedLinearIssue: null,
        isArchived: false,
        isUnread: false,
        isPinned: false,
        sortOrder: 0,
        lastActivityAt: 0,
        projectId: projection.setups[0].projectId,
        projectHostSetupId: 'b',
        priorWorktreeIds: ['b::/old/b']
      }
    }),
    getSettings: () => ({ nestWorkspaces: false, workspaceDir: '' })
  }
}

it('selects current ownership before candidate pressure and fork folding through the store, registry and child boundary', async () => {
  expect(RUNTIME_CAPABILITIES).toContain(AI_VAULT_CANONICAL_PROJECT_SEARCH_CAPABILITY)
  harness = await openSessionSearchHarness('sta10541-native', { sessionCandidateLimit: 2 })
  for (let id = 1; id <= 10; id++) {
    addSyntheticSession(harness.db, {
      id,
      cwd: a.path,
      updatedAt: '2026-10-22',
      text: 'ownership needle'
    })
  }
  addSyntheticSession(harness.db, {
    id: 11,
    cwd: b.path,
    updatedAt: '2026-10-21',
    text: 'ownership needle'
  })
  addSyntheticSession(harness.db, {
    id: 12,
    cwd: '/linked/b',
    updatedAt: '2026-10-20',
    text: 'ownership needle'
  })
  markFork(harness.db, [1, 11], 'shared-opening')
  const native = createSessionSearchService({
    engine: harness.engine,
    indexer: {
      status: () => {
        throw new Error('not called')
      },
      reconcile: async () => undefined
    }
  })
  setSessionSearchService(
    createChildSessionSearchService({
      search: native.search,
      reconcile: native.reconcile,
      status: native.status
    })
  )
  const source = store()
  let catalog = sessionSearchScopeCatalogFromStore(source, 'local')
  installSessionSearchScopeCatalogSource(() => catalog)
  const projectKey = source.getProjects()[0].id
  const request = {
    query: 'ownership needle',
    limit: 1,
    within: { kind: 'project', projectKey: `project:${projectKey}`, canonicalProjectKey: 'repo:b' }
  }
  const first = await searchSessionService(request, 'ipc')
  expect(first).toMatchObject({
    kind: 'results',
    hits: [{ sessionId: '11' }],
    page: { hasMore: true }
  })
  if (first.kind !== 'results' || !first.page.cursor) {
    throw new Error('missing native continuation')
  }
  expect(
    await searchSessionService({ ...request, cursor: first.page.cursor }, 'ipc')
  ).toMatchObject({ kind: 'results', hits: [{ sessionId: '12' }] })
  expect(await searchSessionService({ ...request, query: 'path:repos' }, 'ipc')).toMatchObject({
    kind: 'results',
    hits: [{ sessionId: '11' }]
  })
  expect(
    await searchSessionService(
      { ...request, query: 'different needle', cursor: first.page.cursor },
      'ipc'
    )
  ).toMatchObject({ kind: 'malformed-cursor' })
  expect(
    await searchSessionService(
      {
        ...request,
        within: { ...request.within, canonicalProjectKey: request.within.projectKey },
        cursor: first.page.cursor
      },
      'ipc'
    )
  ).toMatchObject({ kind: 'malformed-cursor' })
  catalog = {
    ...catalog,
    worktreeMeta: { ...catalog.worktreeMeta, 'a::/linked/b': { projectHostSetupId: 'a' } }
  }
  expect(
    await searchSessionService({ ...request, cursor: first.page.cursor }, 'ipc')
  ).toMatchObject({ kind: 'stale-cursor' })
  const legacy = await searchSessionService(
    { query: 'ownership needle', within: { kind: 'project', projectKey: `project:${projectKey}` } },
    'ipc'
  )
  expect(legacy).toMatchObject({ kind: 'results', truncated: { candidates: true } })
})

it('uses literal nested regions and source namespaces without changing legacy cwd keys', async () => {
  const repos: Repo[] = [
    { ...a, id: 'ubuntu', path: '//wsl.localhost/Ubuntu/home/ada/app' },
    { ...a, id: 'debian', gitRemoteIdentity: undefined, path: '//wsl$/Debian/home/ada/app' },
    { ...b, id: 'nested', path: '//wsl.localhost/Ubuntu/home/ada/app/nested' },
    {
      ...a,
      id: 'drive',
      path: '//wsl.localhost/Ubuntu/mnt/c/Case_%/app'
    },
    { ...a, id: 'unicode', path: '/repos/Café_%' },
    { ...a, id: 'native-drive', path: 'C:/Native_%' }
  ]
  const source = store(repos, ['drive', 'unicode', 'native-drive'])
  const catalog = { ...sessionSearchScopeCatalogFromStore(source, 'local'), worktreeMeta: {} }
  const project = source.getProjectHostSetups().find((row) => row.repoId === 'ubuntu')!.projectId
  const selection = await compileSessionSearchProjectOwnership(catalog, `project:${project}`)
  harness = await openSessionSearchHarness('sta10541-native-namespaces')
  const cases = [
    ['/home/ada/app', '//wsl$/Ubuntu/home/ada/.claude/session', true],
    ['/home/ada/app', '//wsl.localhost/Debian/home/ada/.claude/session', false],
    ['/home/ada/app/nested/topic', '//wsl$/Ubuntu/session', false],
    ['/home/ada/app-other', '//wsl$/Ubuntu/session', false],
    ['/mnt/c/CASE_%/app/topic', '/native/session', true],
    ['/mnt/c/CaseXY/app/topic', '/native/session', false],
    ['c:/case_%/app/topic', '/native/session', false],
    ['/repos/Café_%/topic', '/native/session', true],
    ['/repos/café_%/topic', '/native/session', false],
    ['/repos/CaféXY/topic', '/native/session', false],
    ['c:/native_%/topic', '/native/session', true],
    ['C:/NativeXY/topic', '/native/session', false],
    ['//wsl$/Ubuntu/home/ada/app/topic', '/native/session', true]
  ] as const
  for (const [index, [cwd, sessionFilePath]] of cases.entries()) {
    addSyntheticSession(harness.db, { id: index + 1, cwd, sessionFilePath })
  }
  setSessionSearchService(
    createSessionSearchService({
      engine: harness.engine,
      indexer: {
        status: () => {
          throw new Error('not called')
        },
        reconcile: async () => undefined
      }
    })
  )
  installSessionSearchScopeCatalogSource(() => catalog)
  for (const query of ['needle', 'path:/']) {
    const response = await searchSessionService(
      {
        query,
        within: {
          kind: 'project',
          projectKey: `project:${project}`,
          canonicalProjectKey: `project:${project}`
        }
      },
      'ipc'
    )
    expect(response.kind === 'results' && response.hits.map((hit) => hit.sessionId).sort()).toEqual(
      cases.flatMap((row, index) => (row[2] ? [String(index + 1)] : [])).sort()
    )
  }
  expect(sessionSearchProjectOwns(selection, '/home/ada/app', '//wsl$/Ubuntu/session')).toBe(true)
})

it('keeps layout history canonical-only and absent intent at actual legacy native results', async () => {
  harness = await openSessionSearchHarness('sta10541-legacy-layout')
  addSyntheticSession(harness.db, { id: 1, cwd: a.path })
  addSyntheticSession(harness.db, { id: 2, cwd: '/new/a/topic' })
  addSyntheticSession(harness.db, { id: 3, cwd: '/old/a/topic' })
  setSessionSearchService(
    createSessionSearchService({
      engine: harness.engine,
      indexer: {
        status: () => {
          throw new Error('not called')
        },
        reconcile: async () => undefined
      }
    })
  )
  const source = store([a])
  const catalog = {
    ...sessionSearchScopeCatalogFromStore(source, 'local'),
    worktreeMeta: {},
    settings: {
      workspaceDir: '/new',
      nestWorkspaces: true,
      workspaceDirHistory: [{ path: '/old', nestWorkspaces: true }]
    }
  }
  installSessionSearchScopeCatalogSource(() => catalog)
  const projectKey = `project:${source.getProjects()[0].id}`
  const request = { query: 'needle', within: { kind: 'project', projectKey } }
  const legacy = await searchSessionService(request, 'ipc')
  expect(legacy.kind === 'results' && legacy.hits.map((hit) => hit.sessionId).sort()).toEqual([
    '1',
    '2'
  ])
  const canonical = await searchSessionService(
    { ...request, within: { ...request.within, canonicalProjectKey: projectKey } },
    'ipc'
  )
  expect(canonical.kind === 'results' && canonical.hits.map((hit) => hit.sessionId).sort()).toEqual(
    ['1', '2', '3']
  )
})

it('gives a current workspace its native rows when another owner retains a prior symlink spelling', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sta10541-reuse-')))
  try {
    const actual = join(root, 'current')
    const alias = join(root, 'prior')
    await mkdir(actual)
    await symlink(actual, alias, 'junction')
    const repos = [
      { ...a, path: join(root, 'a') },
      { ...b, path: join(root, 'b') }
    ]
    const source = store(repos)
    const template = source.getAllWorktreeMeta()['b::/linked/b']
    const catalog = {
      ...sessionSearchScopeCatalogFromStore(source, 'local'),
      worktreeMeta: {
        [`a::${repos[0].path}/new`]: {
          ...template,
          projectHostSetupId: 'a',
          priorWorktreeIds: [`a::${alias}`]
        },
        [`b::${actual}`]: { ...template, projectHostSetupId: 'b', priorWorktreeIds: [] }
      }
    }
    harness = await openSessionSearchHarness('sta10541-current-alias')
    addSyntheticSession(harness.db, { id: 1, cwd: `${actual}/topic` })
    addSyntheticSession(harness.db, { id: 2, cwd: `${alias}/topic` })
    setSessionSearchService(
      createSessionSearchService({
        engine: harness.engine,
        indexer: {
          status: () => {
            throw new Error('not called')
          },
          reconcile: async () => undefined
        }
      })
    )
    installSessionSearchScopeCatalogSource(() => catalog)
    const within = {
      kind: 'project',
      projectKey: `project:${source.getProjects()[0].id}`,
      canonicalProjectKey: 'repo:b'
    }
    const result = await searchSessionService({ query: 'needle', within }, 'ipc')
    expect(result.kind === 'results' && result.hits.map((hit) => hit.sessionId).sort()).toEqual([
      '1',
      '2'
    ])
    const former = await searchSessionService(
      { query: 'needle', within: { ...within, canonicalProjectKey: within.projectKey } },
      'ipc'
    )
    expect(former.kind === 'results' && former.hits).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('answers one complete provisioned Project above 64 roots before pressure and folds its forks once', async () => {
  const eligible: Repo[] = Array.from({ length: 80 }, (_, index) => ({
    ...a,
    id: `eligible-${index}`,
    path: `/roots/eligible-${index}`,
    addedAt: index
  }))
  const source = store(
    [...eligible, { ...b, path: '/roots/independent', addedAt: 100 }],
    eligible.slice(1).map((repo) => repo.id)
  )
  harness = await openSessionSearchHarness('sta10541-whole-union', { sessionCandidateLimit: 81 })
  for (let id = 1; id <= 80; id++) {
    addSyntheticSession(harness.db, {
      id,
      cwd: eligible[id - 1].path,
      text: 'ownership needle',
      updatedAt: '2026-10-20'
    })
  }
  for (let id = 81; id <= 240; id++) {
    addSyntheticSession(harness.db, {
      id,
      cwd: '/roots/independent',
      text: 'ownership needle',
      updatedAt: '2026-10-21'
    })
  }
  markFork(harness.db, [1, 2, 81], 'union-opening')
  setSessionSearchService(
    createSessionSearchService({
      engine: harness.engine,
      indexer: {
        status: () => {
          throw new Error('not called')
        },
        reconcile: async () => undefined
      }
    })
  )
  installSessionSearchScopeCatalogSource(() => ({
    ...sessionSearchScopeCatalogFromStore(source, 'local'),
    worktreeMeta: {}
  }))
  const projectKey = `project:${source.getProjects()[0].id}`
  for (const query of [
    '"ownership needle"',
    'ownership needle',
    'ownership OR needle',
    'path:roots'
  ]) {
    const response = await searchSessionService(
      {
        query,
        limit: 100,
        within: { kind: 'project', projectKey, canonicalProjectKey: projectKey }
      },
      'ipc'
    )
    expect(response.kind).toBe('results')
    if (response.kind !== 'results') {
      throw new Error('missing native result')
    }
    expect(response.hits).toHaveLength(79)
    expect(response.hits.every((hit) => Number(hit.sessionId) <= 80)).toBe(true)
    expect(response.page.hasMore).toBe(false)
    expect(response.truncated.candidates).toBe(false)
  }
})
