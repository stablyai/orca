import { runProcessSync } from '@orca/process-host'
import { realpathSync } from 'node:fs'
import { mergeWorktree } from './worktree-metadata-merge'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import type { Store } from '../persistence/loading-store/store'
import { registerRepoCreationHandlers } from './repos/repo-creation-handlers'
import { registerRepoCloneHandlers } from './repos/repo-clone-lifecycle'
import { RuntimeRepositoryRegistrationController } from '../runtime/runtime-repository-registration-controller'
import { RuntimeRepositoryCloneController } from '../runtime/runtime-repository-clone-controller'
import { RuntimeManagedWorktreeQueries } from '../runtime/runtime-managed-worktree-queries'
import { partialRuntimeStore, storeWorktreeMeta } from '../runtime/runtime-store-partial-fixture'
import { listRepoWorktrees } from '../repo-worktrees'
import { buildDetectedGitWorktrees } from './worktrees/listing/ssh-worktree-fallback'
import { getProjectHostSetupWorktreeMeta } from '../../shared/project-host-setup-lookup'

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, args: never) => Promise<unknown>>()
}))
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: never) => handlers.set(channel, handler) }
}))
vi.mock('../repo-icon-autodetect', () => ({
  detectRepoIconAndUpstream: vi.fn().mockResolvedValue({})
}))
vi.mock('../worktree-root-preparation', () => ({
  prepareLocalWorktreeRootForRepo: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('./registered-worktree-roots-cache', () => ({ invalidateAuthorizedRootsCache: vi.fn() }))
vi.mock('./repos/repo-added-telemetry', () => ({ emitRepoAdded: vi.fn() }))
vi.mock('./repos/repos-changed-notification', () => ({ notifyReposChanged: vi.fn() }))

const roots: string[] = []
let root: string
let parent: string
let alias: string

function git(cwd: string, args: string[]): void {
  const result = runProcessSync({ program: 'git', args, cwd })
  if (result.code !== 0) {
    throw new Error(result.stderr)
  }
}

function fixture() {
  const repos: Repo[] = []
  const meta: Record<string, ReturnType<typeof storeWorktreeMeta>> = {}
  const store = partialRuntimeStore({
    getRepos: () => repos,
    getRepo: (id) => repos.find((repo) => repo.id === id),
    addRepo: (repo) => {
      repos.push(repo)
    },
    getSettings: () => ({ workspaceDir: join(root, 'workspaces'), nestWorkspaces: true }),
    getAllWorktreeMeta: () => meta,
    getAllWorktreeLineage: () => ({}),
    setWorktreeMeta: ({ id }, patch) => {
      meta[id] = storeWorktreeMeta({ ...meta[id], ...patch })
      return meta[id]
    }
  })
  Object.assign(store, { getProjectHostSetups: () => [] })
  const deps = {
    getStore: () => store,
    invalidateResolvedWorktrees: () => {},
    invalidateWorktreeScan: () => {},
    notifyReposChanged: () => {}
  }
  const create = new RuntimeRepositoryRegistrationController(deps)
  const clone = new RuntimeRepositoryCloneController(deps)
  const window = { isDestroyed: () => false, webContents: { send: vi.fn() } }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: catalog and IPC paths use only the store members supplied by this fixture.
  const ipcStore = store as unknown as Store
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: registration only reads the window's isDestroyed/webContents members.
  registerRepoCreationHandlers(window as never, ipcStore)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: clone registration uses the same window/store boundary as Create.
  registerRepoCloneHandlers(window as never, ipcStore)
  return { repos, meta, store, ipcStore, create, clone }
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'orca-project-alias-')))
  roots.push(root)
  parent = join(root, 'projects')
  alias = join(root, 'alias')
  await mkdir(parent)
  await symlink(parent, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const config = join(root, 'gitconfig')
  await writeFile(
    config,
    '[user]\nname = Fixture\nemail = fixture@example.invalid\n[commit]\ngpgsign = false\n'
  )
  vi.stubEnv('GIT_CONFIG_GLOBAL', config)
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function ipcCreate(parentPath: string, name: string): Promise<Repo> {
  const handler = handlers.get('repos:create')
  if (!handler) {
    throw new Error('Missing create handler')
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these are the registered Create handler's declared arguments/result.
  const result = (await handler(null, { parentPath, name, kind: 'git' } as never)) as {
    repo?: Repo
    error?: string
  }
  if (!result.repo) {
    throw new Error(result.error)
  }
  return result.repo
}
async function ipcClone(url: string, destination: string): Promise<Repo> {
  const handler = handlers.get('repos:clone')
  if (!handler) {
    throw new Error('Missing clone handler')
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these are the registered Clone handler's declared arguments/result.
  return (await handler(null, { url, destination } as never)) as Repo
}

describe.each(['ipc', 'runtime'] as const)('%s Git project root identity', (entry) => {
  it('creates through an alias with a canonical selected checkout and reuses the original request', async () => {
    const f = fixture()
    const create = async () => {
      if (entry === 'ipc') {
        return ipcCreate(alias, 'new-project')
      }
      const result = await f.create.create(alias, 'new-project', 'git')
      if ('error' in result) {
        throw new Error(result.error)
      }
      return result.repo
    }
    const repo = await create()
    expect(repo.path).toBe(await realpath(join(alias, 'new-project')))
    expect((await create()).id).toBe(repo.id)
    expect(f.repos).toHaveLength(1)
    const rows = buildDetectedGitWorktrees(f.ipcStore, repo, await listRepoWorktrees(repo))
    expect(rows).toEqual([
      expect.objectContaining({ path: repo.path, selectedCheckout: true, visible: true })
    ])
  })

  it('clones through an alias with a canonical selected checkout and reuses the original request', async () => {
    const source = join(root, 'source')
    git(root, ['init', '-q', source])
    git(source, ['commit', '-q', '--allow-empty', '-m', 'fixture'])
    const url = pathToFileURL(source).href
    const f = fixture()
    const clone = () => (entry === 'ipc' ? ipcClone(url, alias) : f.clone.clone(url, alias))
    const repo = await clone()
    expect(repo.path).toBe(await realpath(join(alias, 'source')))
    expect((await clone()).id).toBe(repo.id)
    expect(f.repos).toHaveLength(1)
    const rows = buildDetectedGitWorktrees(f.ipcStore, repo, await listRepoWorktrees(repo))
    expect(rows).toEqual([
      expect.objectContaining({ path: repo.path, selectedCheckout: true, visible: true })
    ])
  })
})

it('reopens a saved alias project without changing its physical workspace ID or metadata', async () => {
  const physical = join(parent, 'old-project')
  git(parent, ['init', '-q', physical])
  git(physical, ['commit', '-q', '--allow-empty', '-m', 'fixture'])
  const sibling = join(root, 'external')
  git(physical, ['worktree', 'add', '-q', '-b', 'external', sibling])
  const f = fixture()
  const saved: Repo = {
    id: 'saved-project',
    path: join(alias, 'old-project'),
    displayName: 'old',
    badgeColor: 'blue',
    addedAt: Date.now(),
    kind: 'git',
    externalWorktreeVisibility: 'hide'
  }
  const serialized = JSON.stringify(saved)
  f.repos.push(JSON.parse(serialized))
  const id = `${saved.id}::${physical}`
  f.meta[id] = storeWorktreeMeta({
    ...getProjectHostSetupWorktreeMeta([], saved),
    instanceId: 'kept-instance',
    comment: 'kept details',
    lastActivityAt: 5
  })
  const metadata = JSON.stringify(f.meta)
  const raw = await listRepoWorktrees(saved)
  const desktop = buildDetectedGitWorktrees(f.ipcStore, saved, raw)
  expect(desktop.find((row) => row.id === id)).toMatchObject({
    selectedCheckout: true,
    visible: true,
    comment: 'kept details',
    instanceId: 'kept-instance'
  })
  expect(desktop.find((row) => row.path === sibling)?.visible).toBe(false)
  const queries = new RuntimeManagedWorktreeQueries({
    getStore: () => f.store,
    listResolved: async () => [],
    resolveRepo: async () => saved,
    selectRepos: () => [saved],
    scanRepo: async () => ({ ok: true, worktrees: raw }),
    listKnownHostIds: () => ['local']
  })
  const runtime = await queries.listDetected(saved)
  expect(runtime.worktrees.find((row) => row.id === id)).toMatchObject({
    selectedCheckout: true,
    visible: true,
    comment: 'kept details'
  })
  expect(runtime.worktrees.find((row) => row.path === sibling)?.visible).toBe(false)
  expect(JSON.stringify(f.repos[0])).toBe(serialized)
  expect(JSON.stringify(f.meta)).toBe(metadata)
})

it('bounds identity probes in runtime visibility as the linked-worktree population grows', async () => {
  const physical = join(parent, 'saved')
  await mkdir(physical)
  const f = fixture()
  const repo: Repo = {
    id: 'saved',
    path: join(alias, 'saved'),
    displayName: 'saved',
    badgeColor: 'blue',
    addedAt: Date.now(),
    kind: 'git',
    externalWorktreeVisibility: 'hide'
  }
  f.repos.push(repo)
  const native = vi.spyOn(realpathSync, 'native')
  try {
    for (const count of [10, 100]) {
      const resolved = Array.from({ length: count }, (_, index) => {
        const git = {
          path: index === 0 ? physical : join(root, `linked-${index}`),
          head: 'abc',
          branch: 'main',
          isBare: false,
          isMainWorktree: index === 0
        }
        return {
          ...mergeWorktree(repo.id, git, undefined),
          git,
          parentWorktreeId: null,
          childWorktreeIds: [],
          lineage: null
        }
      })
      const queries = new RuntimeManagedWorktreeQueries({
        getStore: () => f.store,
        listResolved: async () => resolved,
        resolveRepo: async () => repo,
        selectRepos: () => [repo],
        scanRepo: async () => ({ ok: true, worktrees: [] }),
        listKnownHostIds: () => ['local']
      })
      native.mockClear()
      expect((await queries.list(undefined, count)).worktrees.map((row) => row.path)).toEqual([
        physical
      ])
      expect(native.mock.calls.length).toBeLessThanOrEqual(2)
    }
  } finally {
    native.mockRestore()
  }
})

it('does not touch WSL network paths when classifying a cached main row', () => {
  const f = fixture()
  const repo: Repo = {
    id: 'wsl',
    path: String.raw`\\wsl.localhost\Ubuntu\home\user\alias`,
    displayName: 'wsl',
    badgeColor: 'blue',
    addedAt: Date.now(),
    kind: 'git',
    externalWorktreeVisibility: 'hide'
  }
  f.repos.push(repo)
  const worktree = mergeWorktree(
    repo.id,
    {
      path: String.raw`\\wsl.localhost\Ubuntu\home\user\physical`,
      head: 'abc',
      branch: 'main',
      isBare: false,
      isMainWorktree: true
    },
    undefined
  )
  const queries = new RuntimeManagedWorktreeQueries({
    getStore: () => f.store,
    listResolved: async () => [],
    resolveRepo: async () => repo,
    selectRepos: () => [repo],
    scanRepo: async () => ({ ok: true, worktrees: [] }),
    listKnownHostIds: () => ['local']
  })
  const native = vi.spyOn(realpathSync, 'native')
  try {
    expect(queries.isVisible(worktree)).toBe(false)
    expect(native).not.toHaveBeenCalled()
  } finally {
    native.mockRestore()
  }
})

it.skipIf(process.platform !== 'darwin')(
  'creates a visible checkout under the standard /tmp alias',
  async () => {
    const temporaryParent = await mkdtemp('/tmp/orca-project-checkout-')
    roots.push(temporaryParent)
    const f = fixture()
    const repo = await ipcCreate(temporaryParent, 'temporary-project')
    expect(repo.path).toBe(await realpath(join(temporaryParent, 'temporary-project')))
    const rows = buildDetectedGitWorktrees(f.ipcStore, repo, await listRepoWorktrees(repo))
    expect(rows).toEqual([expect.objectContaining({ selectedCheckout: true, visible: true })])
  }
)
