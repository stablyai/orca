import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type * as HostResolution from '../../../shared/execution-host/worktree-execution-host-resolution'
import type { Repo } from '../../../shared/repo-types'
import { isOrcaSessionId } from '../../../shared/orca-session-address'
import { hostWorktreeTarget } from '../../../shared/worktree/host-qualified-identity'
import type { ResolvedWorktree } from '../workspaces/catalog/runtime-worktree-path-identity'
import { RuntimeResolvedWorktreeCache } from '../workspaces/catalog/runtime-resolved-worktree-cache'
import type { RuntimeWorkspaceSelectors } from '../workspaces/workspace-selectors'
import { agentConversationPlaces } from './agent-conversation-list'

/** Repo-index builds, wherever the store or a caller groups repos by id. */
const builds = vi.hoisted(() => ({ count: 0 }))
vi.mock('../../../shared/execution-host/worktree-execution-host-resolution', async (load) => {
  const actual = await load<typeof HostResolution>()
  const counted: typeof actual.createRepoRowExecutionHostLookup = (repos) => {
    builds.count++
    return actual.createRepoRowExecutionHostLookup(repos)
  }
  return {
    ...actual,
    createRepoRowExecutionHostLookup: counted
  }
})
const hooks = vi.hoisted(() => ({
  statuses: new Map<string, { connectionId: string | null }>()
}))
vi.mock('../../agent-hooks/server/agent-hook-server', () => {
  const places = {
    terminalAgentPlaces: async () => [...hooks.statuses.keys()].map((paneKey) => ({ paneKey })),
    getPublicStatusSnapshotForPane: (paneKey: string) => {
      const status = hooks.statuses.get(paneKey)
      return status
        ? [
            {
              ...status,
              paneKey,
              worktreeId: ID,
              orcaSessionId: AGENT,
              state: 'done',
              receivedAt: 1
            }
          ]
        : []
    }
  }
  // The store's own hook-server calls are no-ops here.
  const storeCalls = Object.fromEntries(
    [
      'clearPaneKeyAliasesForPty',
      'getStatusSnapshot',
      'ingestTerminalStatus',
      'registerPaneKeyAlias',
      'setPaneKeyAliasPersistenceListener',
      'stop',
      'transferPaneAuthority'
    ].map((name) => [name, () => undefined])
  )
  return { agentHookServer: { ...storeCalls, ...places } }
})
vi.mock('electron', () => ({
  app: { getPath: () => harness.testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))

const harness = await import('../../persistence/persistence-test-harness')
const { RuntimeWorkspaceSelectors: Selectors } = await import('../workspaces/workspace-selectors')

const ID = 'repo-a::/srv/app'
const AGENT = 'claude_place_0001'
const SSH = 'ssh:server'

beforeEach(() => {
  harness.testState.dir = mkdtempSync(join(tmpdir(), 'orca-place-labels-'))
  hooks.statuses.clear()
  builds.count = 0
})
afterEach(async () => {
  await harness.closeTestStores()
})

const local = (displayName: string): Repo =>
  harness.makeRepo({ id: 'repo-a', path: '/srv/app', displayName, executionHostId: 'local' })
const remote = (displayName: string): Repo =>
  harness.makeRepo({ id: 'repo-a', path: '/srv/app', displayName, connectionId: 'server' })

/** A real store holding `others` unrelated repos plus the same-id pair, target first or last. */
function storeWith(others: number, order: 'local first' | 'ssh first', at: 'first' | 'last') {
  const store = harness.createStore()
  const pair =
    order === 'local first'
      ? [local('Local repo'), remote('Remote repo')]
      : [remote('Remote repo'), local('Local repo')]
  const fillers = Array.from({ length: others }, (_, index) =>
    harness.makeRepo({ id: `other-${index}`, path: `/srv/other-${index}` })
  )
  for (const repo of at === 'first' ? [...pair, ...fillers] : [...fillers, ...pair]) {
    store.addRepo(repo)
  }
  store.setWorktreeMeta(hostWorktreeTarget({ id: ID, hostId: 'local' }), {
    displayName: 'Local workspace',
    displayNameIsPinned: true
  })
  store.setWorktreeMeta(hostWorktreeTarget({ id: ID, hostId: SSH }), {
    displayName: 'Remote workspace',
    displayNameIsPinned: true
  })
  return store
}

function row(id: string, hostId: string, displayName: string): ResolvedWorktree {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the label lookup reads only a row's id, host, repo and name.
  return { id, repoId: id.split('::')[0], hostId, displayName } as unknown as ResolvedWorktree
}

/** A published catalog of `count` unrelated rows, with the pair or not, counting reads of each
 *  row's id: indexing a publication reads every one; a show reads none. */
function catalog(count: number, withPair: boolean) {
  const reads = { count: 0 }
  const rows = Array.from({ length: count }, (_, index) =>
    row(`other-${index % 120}::/srv/w-${index}`, 'local', `w-${index}`)
  )
  if (withPair) {
    rows.push(row(ID, SSH, 'Remote workspace'), row(ID, 'local', 'Local workspace'))
  }
  for (const entry of rows) {
    const id = entry.id
    Object.defineProperty(entry, 'id', {
      get: () => {
        reads.count++
        return id
      }
    })
  }
  return { worktrees: rows, reads }
}

function runtimeOver(
  store: ReturnType<typeof harness.createStore>,
  cache: RuntimeResolvedWorktreeCache
) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a real runtime prototype; the label and place code read only the store and catalog cache assigned here.
  const runtime = Object.create(Selectors.prototype) as RuntimeWorkspaceSelectors
  return Object.assign(runtime, { store, resolvedWorktrees: cache })
}

async function show(runtime: RuntimeWorkspaceSelectors, connectionId: string | null) {
  hooks.statuses.clear()
  hooks.statuses.set('pane-1', { connectionId })
  if (!isOrcaSessionId(AGENT)) {
    throw new Error('expected an Orca session id')
  }
  const places = await agentConversationPlaces(runtime, { kind: 'terminal', orcaSessionId: AGENT })
  return places.map(({ workspace, repo, hostId }) => ({ workspace, repo, hostId }))
}

const LOCAL_PLACE = { workspace: 'Local workspace', repo: 'Local repo', hostId: 'local' }
const REMOTE_PLACE = { workspace: 'Remote workspace', repo: 'Remote repo', hostId: SSH }

it.each([
  [12, 750, 'first'],
  [120, 7_500, 'last']
] as const)(
  'labels a place from keyed records with %i repos and %i workspaces (target %s), warm or cold',
  async (repos, worktrees, at) => {
    const store = storeWith(repos, 'local first', at)
    const getRepos = vi.spyOn(store, 'getRepos')
    const getRepo = vi.spyOn(store, 'getRepo')
    const getAllMeta = vi.spyOn(store, 'getAllWorktreeMeta')
    const cache = new RuntimeResolvedWorktreeCache()
    const runtime = runtimeOver(store, cache)
    // The owner's repo index is built once, by its first keyed read.
    await show(runtime, null)
    builds.count = 0

    const missing = catalog(worktrees, false)
    const warm = catalog(worktrees, true)
    for (const published of [null, missing, warm]) {
      if (published) {
        await cache.getSnapshot(
          async () => ({ worktrees: published.worktrees, platformByRepoId: new Map() }),
          60_000,
          0
        )
        cache.invalidateResolved()
        await cache.getSnapshot(
          async () => ({ worktrees: published.worktrees, platformByRepoId: new Map() }),
          60_000,
          0
        )
        published.reads.count = 0
      }
      for (let repeat = 0; repeat < 3; repeat++) {
        expect(await show(runtime, null)).toEqual([LOCAL_PLACE])
        expect(await show(runtime, 'server')).toEqual([REMOTE_PLACE])
      }
      expect(published?.reads.count ?? 0).toBe(0)
    }

    expect({
      builds: builds.count,
      getRepos: getRepos.mock.calls.length,
      getRepo: getRepo.mock.calls.length,
      getAllMeta: getAllMeta.mock.calls.length
    }).toEqual({
      builds: 0,
      getRepos: 0,
      getRepo: 0,
      getAllMeta: 0
    })
  }
)

it('indexes each equivalent catalog once at publication, never again per show', async () => {
  const store = storeWith(12, 'local first', 'first')
  const cache = new RuntimeResolvedWorktreeCache()
  const runtime = runtimeOver(store, cache)
  await show(runtime, null)
  builds.count = 0

  for (let publication = 0; publication < 3; publication++) {
    const published = catalog(750, true)
    cache.invalidateResolved()
    await cache.getSnapshot(
      async () => ({ worktrees: published.worktrees, platformByRepoId: new Map() }),
      60_000,
      0
    )
    const atPublication = published.reads.count
    for (let repeat = 0; repeat < 3; repeat++) {
      expect(await show(runtime, 'server')).toEqual([REMOTE_PLACE])
    }

    expect(atPublication).toBe(752)
    expect(published.reads.count).toBe(atPublication)
  }
  expect(builds.count).toBe(0)
})

it.each(['local first', 'ssh first'] as const)(
  'keeps each host its own label for one id on two hosts, %s',
  async (order) => {
    const store = storeWith(0, order, 'first')
    const runtime = runtimeOver(store, new RuntimeResolvedWorktreeCache())

    expect(await show(runtime, null)).toEqual([LOCAL_PLACE])
    expect(await show(runtime, 'wsl:Ubuntu')).toEqual([LOCAL_PLACE])
    expect(await show(runtime, 'server')).toEqual([REMOTE_PLACE])
    // A host with no registration of this repo borrows no sibling's name.
    expect(await show(runtime, 'elsewhere')).toEqual([
      { workspace: ID, repo: undefined, hostId: 'ssh:elsewhere' }
    ])
  }
)

it('reads current labels after renames, removal, a host move and invalidation, and only then', async () => {
  const store = storeWith(3, 'local first', 'first')
  const cache = new RuntimeResolvedWorktreeCache()
  const runtime = runtimeOver(store, cache)
  await show(runtime, null)
  builds.count = 0

  // Writes elsewhere in the profile leave the repo index alone.
  store.setWorktreeMeta(hostWorktreeTarget({ id: 'other-0::/srv/other-0', hostId: 'local' }), {
    comment: 'unrelated'
  })
  await show(runtime, null)
  expect(builds.count).toBe(0)

  store.updateRepo({ id: 'repo-a', executionHostId: 'local' }, { displayName: 'Renamed repo' })
  store.setWorktreeMeta(hostWorktreeTarget({ id: ID, hostId: 'local' }), {
    displayName: 'Renamed workspace',
    displayNameIsPinned: true
  })
  expect(await show(runtime, null)).toEqual([
    { workspace: 'Renamed workspace', repo: 'Renamed repo', hostId: 'local' }
  ])

  store.removeProjectForHost({ id: 'repo-a', connectionId: 'server' })
  expect(await show(runtime, 'server')).toEqual([{ workspace: ID, repo: undefined, hostId: SSH }])
  store.addRepo(remote('Back again'))
  // Removal dropped that host's saved name, so the workspace is named after its repo again.
  const readded = { workspace: 'Back again', repo: 'Back again', hostId: SSH }
  expect(await show(runtime, 'server')).toEqual([readded])

  // The same length, with the local registration moved to another host.
  store.removeProjectForHost({ id: 'repo-a', executionHostId: 'local' })
  store.addRepo(harness.makeRepo({ id: 'repo-a', path: '/srv/app', connectionId: 'other-host' }))
  expect((await show(runtime, null))[0]?.repo).toBeUndefined()

  const published = catalog(10, true)
  await cache.getSnapshot(
    async () => ({ worktrees: published.worktrees, platformByRepoId: new Map() }),
    60_000,
    0
  )
  // The published row names the workspace; its repo is read from the store's current record.
  expect(await show(runtime, 'server')).toEqual([{ ...readded, workspace: 'Remote workspace' }])
  cache.invalidateResolved()
  expect(await show(runtime, 'server')).toEqual([readded])
})

it('labels a folder workspace by its own record', () => {
  const store = harness.createStore()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the label reads only the folder's name.
  const docs = { name: 'Docs' } as ReturnType<typeof store.getFolderWorkspace>
  vi.spyOn(store, 'getFolderWorkspace').mockImplementation((id) =>
    id === 'folder-1' ? docs : undefined
  )
  const runtime = runtimeOver(store, new RuntimeResolvedWorktreeCache())

  expect(runtime.getWorkspaceLabel('folder:folder-1', 'local')).toEqual({ workspace: 'Docs' })
  expect(runtime.getWorkspaceLabel('folder:folder-2', 'local')).toBeNull()
})
