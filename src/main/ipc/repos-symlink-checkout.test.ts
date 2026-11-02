import { runProcessSync } from '@orca/process-host'
import { promises as fsPromises, realpathSync } from 'node:fs'
import { mergeWorktree } from './worktree-metadata-merge'
import { mkdir, mkdtemp, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
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
import { buildDetectedGitWorktrees } from './worktrees/listing/ssh-worktree-fallback'
import {
  __resetDetectedWorktreeScanCacheForTests,
  listDetectedGitWorktrees
} from './worktrees/listing/detected-worktree-scan-cache'
import { getProjectHostSetupWorktreeMeta } from '../../shared/project-host-setup-lookup'
import { deriveProjectCheckoutRoot, findProjectAtSameRealPath } from '../project-realpath-identity'
import { scanLocalRepoWorktreesForResolution } from '../runtime/repo-worktree-resolution-scan'
import {
  projectRepoWorktreeRows,
  RESOLVED_WORKTREE_REPO_TIMEOUT_MS,
  scanRepoWorktreeRows
} from '../runtime/repo-worktree-row-resolution'
import { RuntimeNestedRepoImport } from '../runtime/runtime-nested-repo-import'
import type { ResolvedWorktree } from '../runtime/runtime-worktree-path-identity'

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
vi.mock('./registered-worktree-roots-cache', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  invalidateAuthorizedRootsCache: vi.fn(),
  registerWorktreeRootsForRepo: vi.fn()
}))
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
    },
    createProjectGroup: (input) => ({ id: 'group', ...input }),
    moveProjectToGroup: () => {}
  })
  Object.assign(store, {
    getProjectHostSetups: () => [],
    captureNativeLocalWorktreeMetadataScanExpectation: () => undefined
  })
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
  return { repos, meta, store, ipcStore, create, clone, deps }
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
  vi.useRealTimers()
  vi.restoreAllMocks()
  __resetDetectedWorktreeScanCacheForTests()
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

type Fixture = ReturnType<typeof fixture>

async function desktopRows(f: Fixture, repo: Repo) {
  const scan = await listDetectedGitWorktrees(f.ipcStore, repo)
  return buildDetectedGitWorktrees(f.ipcStore, repo, scan.gitWorktrees)
}

/** The runtime's owning-host scan: Git listing plus the attempt's checkout identity. */
function scanRepo(repo: Repo) {
  return scanLocalRepoWorktreesForResolution(repo.path, {}, deriveProjectCheckoutRoot(repo))
}

function runtimeQueries(f: Fixture, repo: Repo, listResolved: () => Promise<ResolvedWorktree[]>) {
  return new RuntimeManagedWorktreeQueries({
    getStore: () => f.store,
    listResolved,
    resolveRepo: async () => repo,
    selectRepos: () => [repo],
    scanRepo,
    listKnownHostIds: () => ['local']
  })
}

function savedRepo(id: string, path: string): Repo {
  return {
    id,
    path,
    displayName: id,
    badgeColor: 'blue',
    addedAt: 1_700_000_000_000,
    kind: 'git',
    externalWorktreeVisibility: 'hide'
  }
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
    expect(await desktopRows(f, repo)).toEqual([
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
    expect(await desktopRows(f, repo)).toEqual([
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
  const saved = savedRepo('saved-project', join(alias, 'old-project'))
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
  const desktop = await desktopRows(f, saved)
  expect(desktop.find((row) => row.id === id)).toMatchObject({
    selectedCheckout: true,
    visible: true,
    comment: 'kept details',
    instanceId: 'kept-instance'
  })
  expect(desktop.find((row) => row.path === sibling)?.visible).toBe(false)
  const runtime = await runtimeQueries(f, saved, async () => []).listDetected(saved)
  expect(runtime.worktrees.find((row) => row.id === id)).toMatchObject({
    selectedCheckout: true,
    visible: true,
    comment: 'kept details'
  })
  expect(runtime.worktrees.find((row) => row.path === sibling)?.visible).toBe(false)
  const scan = await scanRepoWorktreeRows({ store: f.store, scanRepo }, saved, new Map())
  const resolved = projectRepoWorktreeRows(
    { store: f.store, listFolderWorkspaces: () => [] },
    saved,
    scan,
    f.meta
  )
  const listed = await runtimeQueries(f, saved, async () => resolved).list(undefined, 10)
  expect(listed.worktrees.map((row) => row.id)).toEqual([id])
  // The scan's proof stays in this process: no published field carries the saved alias.
  expect(JSON.stringify(listed)).not.toContain(saved.path)
  expect(Object.getOwnPropertySymbols(structuredClone(desktop[0]))).toEqual([])
  expect(JSON.stringify(f.repos[0])).toBe(serialized)
  expect(JSON.stringify(f.meta)).toBe(metadata)
})

it('selects an old alias record registered at a linked checkout and keeps its siblings hidden', async () => {
  const main = join(root, 'main-checkout')
  git(root, ['init', '-q', main])
  git(main, ['commit', '-q', '--allow-empty', '-m', 'fixture'])
  const linked = join(parent, 'linked')
  git(main, ['worktree', 'add', '-q', '-b', 'linked', linked])
  const sibling = join(root, 'sibling')
  git(main, ['worktree', 'add', '-q', '-b', 'sibling', sibling])
  const f = fixture()
  const saved = savedRepo('linked-alias', join(alias, 'linked'))
  f.repos.push(saved)
  const runtime = await runtimeQueries(f, saved, async () => []).listDetected(saved)
  for (const rows of [await desktopRows(f, saved), runtime.worktrees]) {
    expect(rows.find((row) => row.path === linked)).toMatchObject({
      id: `${saved.id}::${linked}`,
      isMainWorktree: false,
      selectedCheckout: true,
      visible: true
    })
    expect(rows.find((row) => row.path === sibling)?.visible).toBe(false)
  }
})

it('keeps the checkout selected on stalled-scan metadata rows once identity settles', async () => {
  const physical = join(parent, 'stalled')
  await mkdir(physical)
  const f = fixture()
  const saved = savedRepo('stalled', join(alias, 'stalled'))
  f.repos.push(saved)
  const id = `${saved.id}::${physical}`
  f.meta[id] = storeWorktreeMeta({ comment: 'kept details' })
  vi.useFakeTimers()
  const scanning = scanRepoWorktreeRows(
    {
      store: f.store,
      scanRepo: () => new Promise(() => {}),
      scanCheckoutRoot: deriveProjectCheckoutRoot
    },
    saved,
    new Map()
  )
  // Joins the attempt's derivation rather than starting another.
  await deriveProjectCheckoutRoot(saved)
  await vi.advanceTimersByTimeAsync(RESOLVED_WORKTREE_REPO_TIMEOUT_MS)
  const scan = await scanning
  expect(scan.ok).toBe(false)
  const resolved = projectRepoWorktreeRows(
    { store: f.store, listFolderWorkspaces: () => [] },
    saved,
    scan,
    f.meta
  )
  const listed = await runtimeQueries(f, saved, async () => resolved).list(undefined, 10)
  expect(listed.worktrees).toEqual([
    expect.objectContaining({ id, isMainWorktree: false, comment: 'kept details' })
  ])
})

it('serves stalled-scan rows by the deadline while identity is pending, without a second probe', async () => {
  const physical = join(parent, 'pending')
  const f = fixture()
  const saved = savedRepo('pending', join(alias, 'pending'))
  f.repos.push(saved)
  f.meta[`${saved.id}::${physical}`] = storeWorktreeMeta({})
  const probe = vi.spyOn(fsPromises, 'realpath').mockImplementation(() => new Promise(() => {}))
  vi.useFakeTimers()
  const deps = {
    store: f.store,
    scanRepo: () => new Promise<never>(() => {}),
    scanCheckoutRoot: deriveProjectCheckoutRoot
  }
  for (const attempt of [1, 2]) {
    const scanning = scanRepoWorktreeRows(deps, saved, new Map())
    await vi.advanceTimersByTimeAsync(RESOLVED_WORKTREE_REPO_TIMEOUT_MS)
    expect(
      (await scanning).worktrees.map((row) => row.path),
      `attempt ${attempt}`
    ).toEqual([physical])
  }
  expect(probe).toHaveBeenCalledTimes(1)
})

it('classifies cached rows with no filesystem probes and picks up a retargeted alias on rescan', async () => {
  const physical = join(parent, 'saved')
  git(parent, ['init', '-q', physical])
  git(physical, ['commit', '-q', '--allow-empty', '-m', 'fixture'])
  const f = fixture()
  const saved = savedRepo('saved', join(alias, 'saved'))
  f.repos.push(saved)
  const rowDeps = { store: f.store, listFolderWorkspaces: () => [] }
  const scan = await scanRepoWorktreeRows({ store: f.store, scanRepo }, saved, new Map())
  const asyncProbe = vi.spyOn(fsPromises, 'realpath')
  const syncProbe = vi.spyOn(realpathSync, 'native')
  for (const count of [10, 100]) {
    const linked = Array.from({ length: count }, (_, index) => {
      const git = {
        path: join(root, `linked-${index}`),
        head: 'abc',
        branch: 'main',
        isBare: false,
        isMainWorktree: false
      }
      return {
        ...mergeWorktree(saved.id, git, undefined),
        git,
        parentWorktreeId: null,
        childWorktreeIds: [],
        lineage: null
      }
    })
    const resolved = [...projectRepoWorktreeRows(rowDeps, saved, scan, f.meta), ...linked]
    const queries = runtimeQueries(f, saved, async () => resolved)
    expect((await queries.list(undefined, count + 1)).worktrees.map((row) => row.path)).toEqual([
      physical
    ])
    expect(resolved.filter((row) => queries.isVisible(row)).map((row) => row.path)).toEqual([
      physical
    ])
  }
  expect(asyncProbe).not.toHaveBeenCalled()
  expect(syncProbe).not.toHaveBeenCalled()

  const moved = join(root, 'moved')
  await mkdir(moved)
  git(moved, ['init', '-q', join(moved, 'saved')])
  git(join(moved, 'saved'), ['commit', '-q', '--allow-empty', '-m', 'fixture'])
  await unlink(alias)
  await symlink(moved, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const rescan = await scanRepoWorktreeRows({ store: f.store, scanRepo }, saved, new Map())
  const retargeted = runtimeQueries(f, saved, async () =>
    projectRepoWorktreeRows(rowDeps, saved, rescan, f.meta)
  )
  expect((await retargeted.list(undefined, 10)).worktrees.map((row) => row.path)).toEqual([
    join(moved, 'saved')
  ])
})

it('does not touch WSL network paths when classifying a cached main row', () => {
  const f = fixture()
  const repo = savedRepo('wsl', String.raw`\\wsl.localhost\Ubuntu\home\user\alias`)
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
  const native = vi.spyOn(realpathSync, 'native')
  const asyncProbe = vi.spyOn(fsPromises, 'realpath')
  expect(deriveProjectCheckoutRoot(repo)).toBeNull()
  expect(runtimeQueries(f, repo, async () => []).isVisible(worktree)).toBe(false)
  expect(native).not.toHaveBeenCalled()
  expect(asyncProbe).not.toHaveBeenCalled()
})

it('matches same-checkout WSL records without probing another distro or a non-WSL target', async () => {
  const ubuntu = { path: String.raw`\\wsl$\Ubuntu\home\user\project` }
  const debian = { path: String.raw`\\wsl.localhost\Debian\home\user\project` }
  const probe = vi.spyOn(fsPromises, 'realpath').mockImplementation(async (path) => String(path))
  expect(
    await findProjectAtSameRealPath(
      [debian, ubuntu],
      String.raw`\\wsl.localhost\Ubuntu\home\user\project`
    )
  ).toBe(ubuntu)
  expect(await findProjectAtSameRealPath([debian, ubuntu], join(root, 'local'))).toBeNull()
  expect(probe.mock.calls.map(([path]) => path)).not.toContain(debian.path)
  expect(
    probe.mock.calls.map(([path]) => path).filter((path) => path === ubuntu.path)
  ).toHaveLength(1)
})

it('recognizes a project created through an alias when importing nested repos from that alias', async () => {
  const f = fixture()
  const created = await f.create.create(alias, 'nested', 'git')
  if ('error' in created) {
    throw new Error(created.error)
  }
  const importer = new RuntimeNestedRepoImport(f.deps)
  const imported = await importer.import({
    parentPath: alias,
    groupName: 'Group',
    projectPaths: [join(alias, 'nested')],
    mode: 'separate'
  })
  expect(imported.projects).toEqual([
    expect.objectContaining({ status: 'already-known', projectId: created.repo.id })
  ])
  expect(f.repos).toHaveLength(1)
})

it.skipIf(process.platform !== 'darwin')(
  'creates a visible checkout under the standard /tmp alias',
  async () => {
    const temporaryParent = await mkdtemp('/tmp/orca-project-checkout-')
    roots.push(temporaryParent)
    const f = fixture()
    const repo = await ipcCreate(temporaryParent, 'temporary-project')
    expect(repo.path).toBe(await realpath(join(temporaryParent, 'temporary-project')))
    expect(await desktopRows(f, repo)).toEqual([
      expect.objectContaining({ selectedCheckout: true, visible: true })
    ])
  }
)
