// Real Git worktree families and every Add Project writer, for project-identity invariants.
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { BrowserWindow } from 'electron'
import type { Repo } from '../../../shared/repository/repo-types'
import type { ProjectGroupImportResult } from '../../../shared/project/groups/project-group-types'
import { addLocalRepoFromPath } from '../../ipc/repos/local-repo-registration'
import { RuntimeRepositoryRegistrationController } from '../../runtime/repositories/runtime-repository-registration-controller'
import { RuntimeNestedRepoImport } from '../../runtime/repositories/runtime-nested-repo-import'
import { registerNestedRepoImportHandler } from '../../ipc/repos/nested-repo-import-handler'
import type { Store } from '../../persistence/loading-store/store'
import type { RuntimeStore } from '../../runtime/construction/runtime-store-contract'

const execFileAsync = promisify(execFile)

export async function git(args: string[], cwd: string): Promise<void> {
  await execFileAsync('git', args, { cwd })
}

export function createStore(seed: Repo[] = []) {
  const repos: Repo[] = [...seed]
  const store = {
    getRepos: () => repos,
    getRepo: (id: string) => repos.find((repo) => repo.id === id),
    addRepo: (repo: Repo) => void repos.push(repo),
    updateRepo: (repo: Repo, updates: Partial<Repo>) => Object.assign(repo, updates),
    getSettings: () => ({}),
    getProjectGroups: () => [],
    createProjectGroup: (input: { name: string }) => ({ id: `group-${input.name}`, ...input }),
    moveProjectToGroup: (repo: Repo, groupId: string) => {
      repo.projectGroupId = groupId
    },
    deleteProjectGroup: () => undefined,
    updateProjectGroup: () => undefined,
    setProjectGroupParents: () => undefined
  }
  return { repos, store }
}

export type FakeStore = ReturnType<typeof createStore>['store']

export function asStore<T extends Store | RuntimeStore>(store: FakeStore | object): T {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each caller reads only the repo, project-group and worktree-meta methods its fake implements.
  return store as unknown as T
}

export function seedRepo(path: string, owner: Partial<Repo> = {}): Repo {
  return {
    id: `seed-${owner.executionHostId ?? owner.connectionId ?? 'unstamped'}`,
    path,
    displayName: 'seed',
    badgeColor: '#000000',
    addedAt: 0,
    kind: 'git',
    ...owner
  }
}

const runtimeDeps = (store: FakeStore) => ({
  getStore: () => asStore<RuntimeStore>(store),
  invalidateResolvedWorktrees: () => undefined,
  invalidateWorktreeScan: () => undefined,
  notifyReposChanged: () => undefined
})

export type NestedImport = (
  store: FakeStore,
  args: {
    parentPath: string
    projectPaths: string[]
    mode: 'group' | 'separate'
    groupName: string
  }
) => Promise<ProjectGroupImportResult>

/** Every Add Project entry point, as the id of the project it registered or reused. */
export type Writer = (store: FakeStore, path: string, parentPath: string) => Promise<string>

function nestedWriter(importNested: NestedImport): Writer {
  return async (store, path, parentPath) => {
    const result = await importNested(store, {
      parentPath,
      projectPaths: [path],
      mode: 'separate',
      groupName: ''
    })
    const projectId = result.projects[0]?.projectId
    if (!projectId) {
      throw new Error(`Nested import failed: ${JSON.stringify(result.projects)}`)
    }
    return projectId
  }
}

export const runtimeNestedImport: NestedImport = (store, args) =>
  new RuntimeNestedRepoImport(runtimeDeps(store)).import(args)

export type IpcHandlers = Map<string, (event: unknown, args: unknown) => Promise<unknown>>

/** The desktop IPC import, through a test file's mocked `ipcMain.handle` registry. */
export function createDesktopNestedImport(handlers: IpcHandlers): NestedImport {
  return async (store, args) => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler hands the window only to the repos-changed notification, which these tests mock.
    registerNestedRepoImportHandler({} as BrowserWindow, asStore<Store>(store), () => undefined)
    const handler = handlers.get('projectGroups:importNested')
    if (!handler) {
      throw new Error('The nested import handler did not register')
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this channel's handler returns ProjectGroupImportResult.
    return (await handler(undefined, args)) as ProjectGroupImportResult
  }
}

export function createWriters(desktopNestedImport: NestedImport): [string, Writer][] {
  return [
    [
      'desktop add',
      async (store, path) => {
        const result = await addLocalRepoFromPath(asStore<Store>(store), path)
        if ('error' in result) {
          throw new Error(result.error)
        }
        return result.repo.id
      }
    ],
    [
      'runtime add',
      async (store, path) =>
        (await new RuntimeRepositoryRegistrationController(runtimeDeps(store)).add(path)).id
    ],
    // Project host setup parses any requested runtime: host as local before it adds.
    [
      'host setup add',
      async (store, path) =>
        (
          await new RuntimeRepositoryRegistrationController(runtimeDeps(store)).add(
            path,
            'git',
            'local'
          )
        ).id
    ],
    ['desktop nested import', nestedWriter(desktopNestedImport)],
    ['runtime nested import', nestedWriter(runtimeNestedImport)]
  ]
}

export async function createScratch(prefix: string): Promise<string> {
  // Canonicalize macOS /var temp paths to match Git's /private/var output.
  return realpath(await mkdtemp(join(tmpdir(), prefix)))
}

/** A committed primary checkout with two linked sibling worktrees, plus an independent clone. */
export async function createWorktreeFamily(scratchDir: string, options: { bare?: boolean } = {}) {
  const parentDir = join(scratchDir, 'parent')
  const seedPath = join(scratchDir, 'seed')
  const primaryPath = join(parentDir, options.bare ? 'primary.git' : 'primary')
  const siblingA = join(parentDir, 'sibling-a')
  const siblingB = join(parentDir, 'sibling-b')
  const clonePath = join(scratchDir, 'clone')
  await mkdir(seedPath, { recursive: true })
  await mkdir(parentDir, { recursive: true })
  await git(['init', '-q', '-b', 'main'], seedPath)
  for (const [key, value] of [
    ['user.email', 'family@example.invalid'],
    ['user.name', 'Checkout Family'],
    ['maintenance.auto', 'false'],
    ['gc.auto', '0']
  ]) {
    await git(['config', key, value], seedPath)
  }
  await writeFile(join(seedPath, 'seed.txt'), 'seed\n')
  await git(['add', '-A'], seedPath)
  await git(['commit', '-qm', 'seed'], seedPath)
  await git(['clone', '-q', ...(options.bare ? ['--bare'] : []), seedPath, primaryPath], scratchDir)
  await git(['worktree', 'add', '-q', '-b', 'a', siblingA], primaryPath)
  await git(['worktree', 'add', '-q', '-b', 'b', siblingB], primaryPath)
  await git(['clone', '-q', seedPath, clonePath], scratchDir)
  return { parentDir, primaryPath, siblingA, siblingB, clonePath }
}
