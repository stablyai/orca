// Real Git proves sibling worktrees share one project however their adds interleave.
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Repo } from '../../../shared/repository/repo-types'
import { installRealWorkerThreadChildProcesses } from '../../worker-thread-child-process/worker-thread-child-process-real.test-fixtures'
import { removeTree } from '../../../shared/file-write/windows-transient-lock-removal'

const metadataGates = vi.hoisted(() => new Map<string, Promise<void>>())
const metadataArrivals = vi.hoisted((): string[] => [])
vi.mock('../../repository-icons/repo-icon-autodetect', () => ({
  detectRepoLocalMetadata: async ({ repoPath }: { repoPath: string }) => {
    metadataArrivals.push(repoPath)
    await metadataGates.get(repoPath)
    return {}
  }
}))
vi.mock('../creation/worktree-root-preparation', () => ({
  prepareLocalWorktreeRootForRepo: async () => undefined
}))

import { addLocalRepoFromPath } from '../../ipc/repos/local-repo-registration'
import { RuntimeRepositoryRegistrationController } from '../../runtime/repositories/runtime-repository-registration-controller'
import { RuntimeNestedRepoImport } from '../../runtime/repositories/runtime-nested-repo-import'
import type { Store } from '../../persistence/loading-store/store'
import type { RuntimeStore } from '../../runtime/construction/runtime-store-contract'

const execFileAsync = promisify(execFile)
installRealWorkerThreadChildProcesses()

let scratchDir = ''
let parentDir = ''
let primaryPath = ''
let siblingA = ''
let siblingB = ''
let clonePath = ''

async function git(args: string[], cwd: string): Promise<void> {
  await execFileAsync('git', args, { cwd })
}

function createStore() {
  const repos: Repo[] = []
  const store = {
    getRepos: () => repos,
    getRepo: (id: string) => repos.find((repo) => repo.id === id),
    addRepo: (repo: Repo) => void repos.push(repo),
    updateRepo: (repo: Repo, updates: Partial<Repo>) => Object.assign(repo, updates),
    getSettings: () => ({}),
    getProjectGroups: () => [],
    createProjectGroup: (input: { name: string }) => ({ id: `group-${input.name}`, ...input }),
    moveProjectToGroup: () => undefined,
    deleteProjectGroup: () => undefined,
    updateProjectGroup: () => undefined,
    setProjectGroupParents: () => undefined
  }
  return { repos, store }
}

type FakeStore = ReturnType<typeof createStore>['store']

function asStore<T extends Store | RuntimeStore>(store: FakeStore): T {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: registration and nested import call only the repo and project-group methods this fake implements.
  return store as unknown as T
}

type Registrar = (store: FakeStore, path: string) => Promise<Repo>

const registrars: [string, Registrar][] = [
  [
    'local',
    async (store, path) => {
      const result = await addLocalRepoFromPath(asStore<Store>(store), path)
      if ('error' in result) {
        throw new Error(result.error)
      }
      return result.repo
    }
  ],
  [
    'runtime',
    (store, path) =>
      new RuntimeRepositoryRegistrationController({
        getStore: () => asStore<RuntimeStore>(store),
        invalidateResolvedWorktrees: () => undefined,
        invalidateWorktreeScan: () => undefined,
        notifyReposChanged: () => undefined
      }).add(path)
  ]
]

function gate(path: string): () => void {
  let open = (): void => undefined
  metadataGates.set(
    path,
    new Promise<void>((resolve) => {
      open = resolve
    })
  )
  return open
}

beforeEach(async () => {
  // Canonicalize macOS /var temp paths to match Git's /private/var output.
  scratchDir = await realpath(await mkdtemp(join(tmpdir(), 'orca-checkout-family-')))
  parentDir = join(scratchDir, 'parent')
  primaryPath = join(parentDir, 'primary')
  siblingA = join(parentDir, 'sibling-a')
  siblingB = join(parentDir, 'sibling-b')
  clonePath = join(scratchDir, 'clone')
  await mkdir(primaryPath, { recursive: true })
  await git(['init', '-q'], primaryPath)
  await git(['config', 'user.email', 'family@example.invalid'], primaryPath)
  await git(['config', 'user.name', 'Checkout Family'], primaryPath)
  await git(['config', 'maintenance.auto', 'false'], primaryPath)
  await git(['config', 'gc.auto', '0'], primaryPath)
  await writeFile(join(primaryPath, 'seed.txt'), 'seed\n')
  await git(['add', '-A'], primaryPath)
  await git(['commit', '-qm', 'seed'], primaryPath)
  await git(['worktree', 'add', '-q', siblingA, '-b', 'a'], primaryPath)
  await git(['worktree', 'add', '-q', siblingB, '-b', 'b'], primaryPath)
  await git(['clone', '-q', primaryPath, clonePath], scratchDir)
  metadataGates.clear()
  metadataArrivals.length = 0
  // Real Git fixture setup can exceed the default hook budget on a busy machine.
}, 60_000)

afterEach(async () => {
  metadataGates.clear()
  await removeTree(scratchDir)
}, 60_000)

describe.each(registrars)('%s registration of linked worktrees', (_owner, register) => {
  it('reuses the project an earlier sibling worktree registered', async () => {
    const { repos, store } = createStore()
    const first = await register(store, siblingA)
    const second = await register(store, siblingB)
    expect(second.id).toBe(first.id)
    expect(repos).toHaveLength(1)
  })

  it.each([
    ['A first', 0],
    ['B first', 1]
  ])('registers one project when sibling adds overlap (%s)', async (_order, firstIndex) => {
    const { repos, store } = createStore()
    const paths = [siblingA, siblingB]
    const opens = paths.map(gate)
    const adds = paths.map((path) => register(store, path))
    // Both adds are now past their pre-metadata checks against an empty store.
    await vi.waitFor(() => expect(metadataArrivals).toHaveLength(2), { timeout: 30_000 })
    opens[firstIndex]()
    await adds[firstIndex]
    opens[1 - firstIndex]()
    const [a, b] = await Promise.all(adds)
    expect(a.id).toBe(b.id)
    expect(repos).toHaveLength(1)
  })

  it('keeps an independent clone as its own project', async () => {
    const { repos, store } = createStore()
    await register(store, siblingA)
    await register(store, clonePath)
    expect(repos).toHaveLength(2)
  })
})

describe('runtime nested import of a linked worktree family', () => {
  it('reuses the project a direct add registered for a sibling worktree', async () => {
    const { repos, store } = createStore()
    const direct = await registrars[1][1](store, siblingB)
    const result = await new RuntimeNestedRepoImport({
      getStore: () => asStore<RuntimeStore>(store),
      invalidateResolvedWorktrees: () => undefined,
      invalidateWorktreeScan: () => undefined,
      notifyReposChanged: () => undefined
    }).import({ parentPath: parentDir, groupName: '', projectPaths: [siblingA], mode: 'separate' })
    expect(result.projects).toEqual([
      expect.objectContaining({ projectId: direct.id, status: 'already-known' })
    ])
    expect(repos).toHaveLength(1)
  })
})
