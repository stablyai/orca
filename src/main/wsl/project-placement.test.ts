import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodePath from 'node:path'
import type * as NodeFsPromises from 'node:fs/promises'
import { realpath } from 'node:fs/promises'
import type { NestedRepoScanResult, ProjectGroup } from '../../shared/project-group-types'
import type { BrowserWindow } from 'electron'
import type { Repo } from '../../shared/repo-types'
import type { Store } from '../persistence'
import type { RuntimeStore } from '../runtime/runtime-store-contract'

type PlacementTestState = {
  ownerRepos: Repo[]
  target: (path: string) => string
  mainRepoPath?: string
  handlers: Map<string, (event: unknown, args: unknown) => Promise<unknown>>
  scan?: NestedRepoScanResult
}
const mocks = vi.hoisted(() => {
  const state: PlacementTestState = { ownerRepos: [], target: (path) => path, handlers: new Map() }
  return Object.assign(state, {
    ensure: vi.fn(async (_distro: string) => 'wsl:ubuntu'),
    call: vi.fn(),
    mkdir: vi.fn(),
    access: vi.fn(),
    readdir: vi.fn(),
    rm: vi.fn()
  })
})
// Why win32: the handlers resolve these UNC parents as Windows does; POSIX would call them relative.
vi.mock('node:path', async (importOriginal) => {
  const actual = await importOriginal<typeof NodePath>()
  return { ...actual.win32, default: actual.win32, posix: actual.posix, win32: actual.win32 }
})
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeFsPromises>()),
  access: mocks.access,
  mkdir: mocks.mkdir,
  readdir: mocks.readdir,
  rm: mocks.rm,
  realpath: vi.fn(async (path: string) => path)
}))
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: never) => mocks.handlers.set(channel, handler) }
}))
vi.mock('./wsl-host-service-instance', () => ({
  getWslHostService: () => ({
    isEnabled: () => true,
    ensure: mocks.ensure,
    callProject: mocks.call
  })
}))
vi.mock('../git/runner', () => ({
  awaitWindowsHostGitEnvironmentReady: vi.fn(async () => {}),
  gitExecFileAsync: vi.fn()
}))
vi.mock('../git/repo', () => ({
  inspectGitRepoForRegistrationAsync: vi.fn(async (path: string) => ({
    isRepo: true,
    rootPath: mocks.target(path),
    mainRepoPath: mocks.mainRepoPath
  })),
  getGitRepoRootAsync: vi.fn(async (path: string) => path),
  getRepoName: (path: string) => path.split(/[\\/]/).pop() ?? path,
  isGitRepoAsync: vi.fn(async () => true)
}))
vi.mock('../project-groups/nested-repo-import-target', () => ({
  createNestedRepoImportTargetResolver: () => ({
    resolveLocal: async (path: string) => mocks.target(path)
  })
}))
vi.mock('../ipc/repos/nested-repo-scan-ipc', () => ({
  getCompletedNestedRepoScan: () => mocks.scan,
  scanNestedReposForIpc: vi.fn()
}))
vi.mock('../ipc/repos/repos-changed-notification', () => ({ notifyReposChanged: vi.fn() }))
vi.mock('../ipc/repos/repo-added-telemetry', () => ({ emitRepoAdded: vi.fn() }))
vi.mock('../ipc/registered-worktree-roots-cache', () => ({
  invalidateAuthorizedRootsCache: vi.fn()
}))
vi.mock('../repo-icon-autodetect', () => ({ detectRepoIconAndUpstream: vi.fn(async () => ({})) }))
vi.mock('../worktree-root-preparation', () => ({
  prepareLocalWorktreeRootForRepo: vi.fn(async () => {})
}))

import { gitExecFileAsync } from '../git/runner'
import { resolveGitCommandWithoutProbe } from '../git/command-runner/git-command-resolution'
import { registerRepoCreationHandlers } from '../ipc/repos/repo-creation-handlers'
import { registerNestedRepoImportHandler } from '../ipc/repos/nested-repo-import-handler'
import { addLocalRepoFromPath } from '../ipc/repos/local-repo-registration'
import { placeProject } from './project-placement'
import { RuntimeRepositoryRegistrationController } from '../runtime/runtime-repository-registration-controller'

const OWNER = 'runtime:wsl%3Aubuntu'
const OLD_PEER_METHODS = new Set([
  'repo.list',
  'repo.add',
  'repo.create',
  'projectHostSetup.list',
  'project.list',
  'projectHostSetup.setupExistingFolder',
  'projectGroup.create',
  'projectGroup.moveProject'
])
const row = (id: string, path: string, extra: Partial<Repo> = {}): Repo => ({
  id,
  path,
  displayName: id,
  badgeColor: 'blue',
  addedAt: 1,
  kind: 'git',
  ...extra
})

function makeStore(repos: Repo[], gatesOn = true) {
  let groups = 0
  const store = {
    repos,
    getRepos: () => repos,
    getSettings: () => ({ experimentalWslHosts: gatesOn }),
    addRepo: vi.fn((repo: Repo) => repos.push(repo)),
    createProjectGroup: vi.fn((input: Partial<ProjectGroup>) => ({
      ...input,
      id: `local-group-${++groups}`
    })),
    moveProjectToGroup: vi.fn(),
    deleteProjectGroup: vi.fn()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these callers only use the methods above.
  return store as typeof store & Store & RuntimeStore
}
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: handlers pass it only to the mocked notifier.
const mainWindow = {} as BrowserWindow

function scanOf(parent: string, paths: string[]): NestedRepoScanResult {
  return {
    selectedPath: parent,
    selectedPathKind: 'non_git_folder',
    repos: paths.map((path) => ({ path, displayName: 'repo', depth: 1 })),
    truncated: false,
    timedOut: false,
    stopped: false,
    durationMs: 1,
    maxDepth: 5,
    maxRepos: 100,
    timeoutMs: 15000
  }
}

const originalPlatform = process.platform

describe('one placement per project operation', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    vi.stubEnv('ORCA_INTERNAL_WSL_HOSTS', '1')
    mocks.ensure.mockReset().mockResolvedValue('wsl:ubuntu')
    mocks.mkdir.mockReset().mockResolvedValue(undefined)
    mocks.access.mockReset().mockResolvedValue(undefined)
    mocks.readdir.mockReset().mockResolvedValue([])
    mocks.rm.mockReset().mockResolvedValue(undefined)
    vi.mocked(gitExecFileAsync).mockReset().mockResolvedValue({ stdout: '', stderr: '' })
    vi.mocked(realpath).mockClear()
    mocks.ownerRepos = []
    mocks.target = (path) => path
    mocks.mainRepoPath = undefined
    mocks.handlers.clear()
    let groups = 0
    mocks.call
      .mockReset()
      .mockImplementation(async (_env, method, params, beforeSend?: () => void) => {
        beforeSend?.()
        const replies: Record<string, () => unknown> = {
          'repo.list': () => ({ repos: [...mocks.ownerRepos] }),
          'projectHostSetup.list': () => ({
            setups: mocks.ownerRepos.map((repo) => ({
              projectId: 'owner-project',
              repoId: repo.id,
              path: repo.path,
              hostId: 'local',
              setupMethod: 'imported-existing-folder'
            }))
          }),
          'project.list': () => ({ projects: [{ id: 'owner-project' }] }),
          'projectGroup.create': () => ({
            group: {
              ...params,
              id: `guest-group-${++groups}`,
              parentPath: params.parentPath ?? null,
              tabOrder: 0,
              isCollapsed: false,
              color: null,
              createdAt: 1,
              updatedAt: 1
            }
          }),
          'projectGroup.moveProject': () => ({ repo: {} })
        }
        const reply = replies[method]
        if (reply) {
          return reply()
        }
        const path = method === 'repo.create' ? `${params.parentPath}/${params.name}` : params.path
        const repo =
          mocks.ownerRepos.find((owned) => owned.path === path) ?? row(`guest:${path}`, path)
        mocks.ownerRepos.push(repo)
        return { repo }
      })
  })
  afterEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    vi.unstubAllEnvs()
  })

  it.each(['wsl.localhost', 'wsl$'])(
    'places extended %s Add and Create without losing Linux case',
    async (share) => {
      const parentPath = `\\\\?\\UNC\\${share}\\Ubuntu\\home\\me`
      const selectedPath = `${parentPath}\\App`
      const saved = row('windows-App', selectedPath, { kind: 'folder' })
      registerRepoCreationHandlers(mainWindow, makeStore([]))
      for (const operation of ['add', 'create']) {
        await expect(
          mocks.handlers.get(`repos:${operation}`)!(null, {
            path: selectedPath,
            parentPath,
            name: 'App',
            kind: 'folder'
          })
        ).resolves.toMatchObject({ repo: { path: '/home/me/App', executionHostId: OWNER } })
      }
      await expect(
        addLocalRepoFromPath(makeStore([saved]), selectedPath, 'folder')
      ).resolves.toEqual({ repo: saved, alreadyExisted: true })
    }
  )

  it('normalizes Git registration output while retaining the selected cwd', async () => {
    const selectedPath = '\\\\?\\UNC\\wsl$\\Ubuntu\\home\\me\\App\\src'
    mocks.target = () => '\\\\?\\UNC\\wsl.localhost\\Ubuntu\\home\\me\\App'
    const placement = await placeProject(makeStore([]), {
      operation: 'add',
      selectedPath,
      kind: 'git',
      domain: 'local',
      fromPairedClient: false,
      claimsOutsideWsl: { scope: 'desktop' }
    })
    expect(placement).toMatchObject({
      kind: 'wsl',
      linuxPath: '/home/me/App',
      selectedPath: '\\\\wsl$\\Ubuntu\\home\\me\\App\\src'
    })
  })

  it.each(['add', 'create'])(
    '%s keeps only recognized drvfs folders Windows-owned',
    async (operation) => {
      for (const mount of ['mnt\\c', 'MNT\\c', 'mnt\\C', 'mnt\\cdrom', 'home\\me']) {
        const parentPath = `\\\\wsl.localhost\\Ubuntu\\${mount}`
        const path = `${parentPath}\\App`
        const store = makeStore([])
        mocks.ensure.mockClear()
        registerRepoCreationHandlers(mainWindow, store)
        const result = await mocks.handlers.get(`repos:${operation}`)!(null, {
          path,
          parentPath,
          name: 'App',
          kind: 'folder'
        })
        expect(result).toMatchObject({
          repo: { path: mount === 'mnt\\c' ? path : `/${mount.replace(/\\/g, '/')}/App` }
        })
        if (mount === 'mnt\\c') {
          expect(store.addRepo).toHaveBeenCalledWith(expect.objectContaining({ path }))
          expect(mocks.ensure).not.toHaveBeenCalled()
        } else {
          expect(result).toMatchObject({ repo: { executionHostId: OWNER } })
          expect(store.addRepo).not.toHaveBeenCalled()
        }
      }
    }
  )

  it('creates a Windows-owned Git project through a denied UNC drive mount without overwriting or over-deleting', async () => {
    const parentPath = String.raw`\\wsl.localhost\Ubuntu\mnt\c\Users\qa\DriveParent`
    const targetPath = `${parentPath}\\App`
    const driveParent = String.raw`C:\Users\qa\DriveParent`
    const driveTarget = `${driveParent}\\App`
    let exists = false
    let entries: string[] = []
    const opened: string[] = []
    const open = (path: string) => {
      if (path.startsWith('\\\\')) {
        throw Object.assign(new Error(`EPERM: operation not permitted, '${path}'`), {
          code: 'EPERM'
        })
      }
      opened.push(path)
    }
    mocks.mkdir.mockImplementation(async (path: string) => {
      open(path)
      if (path === driveTarget) {
        exists = true
      }
    })
    mocks.access.mockImplementation(async (path: string) => {
      open(path)
      if (!exists) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }
    })
    mocks.readdir.mockImplementation(async (path: string) => {
      open(path)
      return entries
    })
    mocks.rm.mockImplementation(async (path: string) => {
      open(path)
      if (path === driveTarget) {
        exists = false
      }
    })
    const repos: Repo[] = []
    const store = makeStore(repos)
    registerRepoCreationHandlers(mainWindow, store)
    const create = () =>
      mocks.handlers.get('repos:create')!(null, { parentPath, name: 'App', kind: 'git' })

    await expect(create()).resolves.toMatchObject({ repo: { path: targetPath, kind: 'git' } })
    expect(repos[0].executionHostId ?? 'local').toBe('local')
    expect(mocks.ensure).not.toHaveBeenCalled()
    expect(mocks.mkdir.mock.calls).toEqual([
      [driveParent, { recursive: true }],
      [driveTarget, { recursive: false }]
    ])
    expect(vi.mocked(gitExecFileAsync).mock.calls).toEqual([
      [['init'], { cwd: targetPath }],
      [['commit', '--allow-empty', '-m', 'Initial commit'], { cwd: targetPath }]
    ])
    const command = resolveGitCommandWithoutProbe(['init'], { cwd: targetPath })
    expect(command.binary).toBe('wsl.exe')
    expect(command.args.at(-1)).toContain("cd '/mnt/c/Users/qa/DriveParent/App' && ")
    expect(command.cwd).not.toBe(targetPath)
    repos.length = 0
    entries = ['keep.txt']
    store.addRepo.mockClear()
    vi.mocked(gitExecFileAsync).mockClear()
    await expect(create()).resolves.toMatchObject({ error: expect.stringContaining('not empty') })
    expect(gitExecFileAsync).not.toHaveBeenCalled()
    expect(store.addRepo).not.toHaveBeenCalled()
    expect(mocks.rm).not.toHaveBeenCalled()

    exists = false
    entries = []
    vi.mocked(gitExecFileAsync).mockRejectedValueOnce(new Error('init failed'))
    await expect(create()).resolves.toMatchObject({
      error: expect.stringContaining('Failed to initialize')
    })
    expect(mocks.rm).toHaveBeenLastCalledWith(driveTarget, { recursive: true, force: true })
    expect(exists).toBe(false)
    exists = true
    mocks.rm.mockClear()
    vi.mocked(gitExecFileAsync)
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockRejectedValueOnce(new Error('commit failed'))
    await expect(create()).resolves.toMatchObject({
      error: expect.stringContaining('Failed to create initial commit')
    })
    expect(mocks.rm).toHaveBeenCalledExactlyOnceWith(`${driveTarget}\\.git`, {
      recursive: true,
      force: true
    })
    expect(exists).toBe(true)
    expect(store.addRepo).not.toHaveBeenCalled()
    expect(
      opened.every(
        (path) => path === driveParent || path === driveTarget || path === `${driveTarget}\\.git`
      )
    ).toBe(true)
  })

  it('matches selected/root/non-folder-main on an old owner without adopting foreign or case-neighbor rows', async () => {
    const root = '\\\\wsl$\\Ubuntu\\home\\me\\topic'
    const mainPath = '\\\\wsl.localhost\\ubuntu\\home\\me\\App'
    mocks.target = () => root
    const main = row('main', '/home/me/App', { projectHostSetupMethod: 'cloned' })
    const checkout = row('root', '/home/me/topic', { executionHostId: 'local' })
    const child = row('selected', '/home/me/topic/src', { executionHostId: OWNER })
    const ineligible = [
      row('folder', main.path, { kind: 'folder' }),
      row('foreign', main.path, { executionHostId: 'runtime:other' }),
      row('ssh', main.path, { connectionId: 'ssh-1' }),
      row('nested-ssh', main.path, { executionHostId: OWNER, connectionId: 'ssh-1' }),
      row('case-neighbor', '/home/me/app')
    ]
    for (const [catalog, proof, expected] of [
      [ineligible, mainPath, row('guest:/home/me/topic', '/home/me/topic')],
      [[main], mainPath.replace('ubuntu', 'Debian'), row('guest:/home/me/topic', '/home/me/topic')],
      [[main], mainPath, main],
      [[main, checkout], mainPath, checkout],
      [[main, checkout, child], mainPath, child]
    ] as const) {
      mocks.ownerRepos = [...catalog]
      mocks.mainRepoPath = proof
      mocks.call.mockClear()
      await expect(addLocalRepoFromPath(makeStore([]), `${root}\\src`)).resolves.toMatchObject({
        repo: { ...expected, executionHostId: OWNER }
      })
      if (!expected.id.startsWith('guest:')) {
        expect(mocks.call.mock.calls.map(([, method]) => method)).toEqual(['repo.list'])
      } else {
        expect(mocks.call).toHaveBeenCalledWith(
          'wsl:ubuntu',
          'repo.add',
          expect.objectContaining({ path: '/home/me/topic' }),
          expect.any(Function)
        )
      }
    }
  })

  it('groups an existing guest checkout without treating its receipt as Windows or rewriting setup', async () => {
    const parentPath = '\\\\wsl$\\Ubuntu\\home\\me'
    const path = `${parentPath}\\App`
    mocks.scan = scanOf(parentPath, [path])
    mocks.ownerRepos = [row('guest-existing', '/home/me/App', { projectHostSetupMethod: 'cloned' })]
    registerNestedRepoImportHandler(mainWindow, makeStore([]))
    await expect(
      mocks.handlers.get('projectGroups:importNested')!(null, {
        parentPath,
        projectPaths: [path],
        mode: 'group',
        scanId: 'scan-1'
      })
    ).resolves.toMatchObject({
      alreadyKnownCount: 1,
      projects: [{ projectId: 'guest-existing', status: 'already-known', executionHostId: OWNER }],
      group: { executionHostId: OWNER }
    })
    expect(
      mocks.call.mock.calls.filter(
        ([, method]) => method === 'repo.add' || method.startsWith('projectHostSetup.')
      )
    ).toEqual([])
  })

  it.each([true, false])(
    'finishes zero viable nested selections before provisioning (inspection=%s)',
    async (inspect) => {
      const parentPath = '\\\\wsl$\\Ubuntu\\home\\me'
      const [a, b, missing] = ['a', 'b', 'missing'].map((name) => `${parentPath}\\${name}`)
      mocks.scan = scanOf(parentPath, inspect ? [a, b] : [])
      mocks.target = () => {
        throw new Error('Repository disappeared')
      }
      const store = makeStore([])
      registerNestedRepoImportHandler(mainWindow, store)
      const projectPaths = inspect ? [b, missing, a, b] : [missing, missing]
      await expect(
        mocks.handlers.get('projectGroups:importNested')!(null, {
          parentPath,
          projectPaths,
          mode: 'group',
          scanId: 'scan-1'
        })
      ).resolves.toEqual({
        importedCount: 0,
        alreadyKnownCount: 0,
        failedCount: inspect ? 3 : 1,
        projects: (inspect ? [b, missing, a] : [missing]).map((path) => ({
          path,
          status: 'failed',
          error:
            path === missing
              ? 'Repository was not found in the nested repo scan result'
              : 'Repository disappeared'
        }))
      })
      expect(mocks.ensure).not.toHaveBeenCalled()
      expect(mocks.call).not.toHaveBeenCalled()
      expect(store.createProjectGroup).not.toHaveBeenCalled()
    }
  )

  it.each(['create', 'nested'] as const)(
    '%s never traverses unrelated saved UNC or native-link catalog paths',
    async (operation) => {
      const parentPath = '\\\\wsl.localhost\\Ubuntu\\home\\me'
      const selected = `${parentPath}\\new`
      const store = makeStore([
        row('foreign-distro', '\\\\wsl.localhost\\Debian\\home\\me\\old'),
        row('native-link', 'C:\\aliases\\foreign')
      ])
      registerRepoCreationHandlers(mainWindow, store)
      registerNestedRepoImportHandler(mainWindow, store)
      mocks.scan = scanOf(parentPath, [selected])
      const result = await mocks.handlers.get(
        operation === 'create' ? 'repos:create' : 'projectGroups:importNested'
      )!(null, {
        parentPath,
        name: 'new',
        kind: 'folder',
        projectPaths: [selected],
        mode: 'separate',
        scanId: 'scan-1'
      })
      expect(result).toMatchObject(
        operation === 'create'
          ? { repo: { path: '/home/me/new', executionHostId: OWNER } }
          : { importedCount: 1, projects: [{ status: 'imported', executionHostId: OWNER }] }
      )
      expect(realpath).not.toHaveBeenCalled()
      expect(mocks.ensure).toHaveBeenCalledExactlyOnceWith('Ubuntu')
    }
  )

  it("creates on the named distro instead of returning another machine's project at an alias", async () => {
    const foreign = row('other-windows-notes', '\\\\wsl$\\Ubuntu\\home\\me\\notes', {
      kind: 'folder',
      executionHostId: 'runtime:other-windows'
    })
    const request = {
      parentPath: '\\\\wsl.localhost\\Ubuntu\\home\\me',
      name: 'notes',
      kind: 'folder'
    }
    registerRepoCreationHandlers(mainWindow, makeStore([foreign]))
    await expect(mocks.handlers.get('repos:create')!(null, request)).resolves.toMatchObject({
      repo: { path: '/home/me/notes', executionHostId: OWNER }
    })
    expect(mocks.call).toHaveBeenCalledWith(
      'wsl:ubuntu',
      'repo.create',
      {
        parentPath: '/home/me',
        name: 'notes',
        kind: 'folder'
      },
      expect.any(Function)
    )

    // This desktop's own Windows row at the other alias keeps the project.
    const saved = row('saved-notes', foreign.path, { kind: 'folder' })
    mocks.ensure.mockClear()
    registerRepoCreationHandlers(mainWindow, makeStore([saved]))
    await expect(mocks.handlers.get('repos:create')!(null, request)).resolves.toEqual({
      repo: saved
    })
    expect(mocks.ensure).not.toHaveBeenCalled()
  })

  it('adds a new selection on its distro at the verified root and keeps saved and gated-off paths on Windows', async () => {
    const saved = row('saved-repo', '\\\\wsl$\\Ubuntu\\home\\me\\old')
    const child = '\\\\wsl.localhost\\ubuntu\\home\\me\\old\\packages\\ui'
    mocks.target = (path) => (path === child ? saved.path : path)
    await expect(
      addLocalRepoFromPath(
        makeStore([row(saved.id, '/peer', { executionHostId: 'ssh:peer' }), saved]),
        child
      )
    ).resolves.toEqual({
      repo: saved,
      alreadyExisted: true
    })
    expect(mocks.ensure).not.toHaveBeenCalled()

    const added = await addLocalRepoFromPath(makeStore([]), child)
    expect(added).toMatchObject({
      repo: { path: '/home/me/old', executionHostId: OWNER },
      alreadyExisted: false
    })
    expect(mocks.call).toHaveBeenCalledWith(
      'wsl:ubuntu',
      'repo.add',
      expect.objectContaining({ path: '/home/me/old' }),
      expect.any(Function)
    )

    const gatedOff = makeStore([], false)
    vi.stubEnv('ORCA_INTERNAL_WSL_HOSTS', '0')
    await addLocalRepoFromPath(gatedOff, '\\\\wsl$\\Ubuntu\\home\\me\\new')
    expect(gatedOff.addRepo).toHaveBeenCalledWith(
      expect.objectContaining({ path: '\\\\wsl$\\Ubuntu\\home\\me\\new' })
    )
    expect(mocks.ensure).toHaveBeenCalledTimes(1)
    const native = row('same', 'C:\\notes', { kind: 'folder', executionHostId: 'runtime:env-1' })
    registerRepoCreationHandlers(
      mainWindow,
      makeStore([row('same', '/peer', { executionHostId: 'ssh:peer' }), native], false)
    )
    await expect(
      mocks.handlers.get('repos:add')!(null, { path: native.path, kind: 'folder' })
    ).resolves.toEqual({ repo: native })
  })

  it('lets a paired caller reuse a saved project but never start a new WSL owner', async () => {
    const saved = row('saved-repo', '\\\\wsl$\\Ubuntu\\home\\me\\old')
    const store = makeStore([row(saved.id, '/peer', { executionHostId: 'runtime:peer' }), saved])
    const controller = new RuntimeRepositoryRegistrationController({
      getStore: () => store,
      invalidateResolvedWorktrees: vi.fn(),
      invalidateWorktreeScan: vi.fn(),
      notifyReposChanged: vi.fn()
    })
    const paired = { fromPairedClient: true }
    await expect(controller.add(saved.path, 'git', undefined, undefined, paired)).resolves.toBe(
      saved
    )
    await expect(
      controller.add('\\\\wsl$\\Ubuntu\\home\\me\\new', 'git', undefined, undefined, paired)
    ).rejects.toThrow('Windows desktop')
    expect(mocks.ensure).not.toHaveBeenCalled()
    expect(store.addRepo).not.toHaveBeenCalled()
    const captured = await placeProject(store, {
      operation: 'add',
      selectedPath: saved.path,
      kind: 'git',
      domain: null,
      fromPairedClient: true,
      claimsOutsideWsl: { scope: 'runtime', executionHostId: undefined }
    })
    store.repos.splice(1, 1)
    await expect(controller.addPlaced(captured, 'git')).rejects.toThrow('changed')
  })

  it.each(['list-claim', 'send-claim', 'send-stop'])(
    'rechecks the admitted owner after preparation: %s',
    async (phase) => {
      const path = '\\\\wsl$\\Ubuntu\\home\\me\\late'
      const saved = row('windows-late', path, { kind: 'folder' })
      const store = makeStore([])
      const normal = mocks.call.getMockImplementation()!
      mocks.call.mockImplementation(async (env, method, params, beforeSend) => {
        if (
          (phase === 'list-claim' && method === 'repo.list') ||
          (phase === 'send-claim' && method === 'repo.add')
        ) {
          store.repos.push(saved)
        }
        if (phase === 'send-stop' && method === 'repo.add') {
          vi.stubEnv('ORCA_INTERNAL_WSL_HOSTS', '0')
        }
        if (phase === 'list-claim' && method === 'repo.list') {
          return { repos: [row('guest-late', '/home/me/late')] }
        }
        return normal(env, method, params, beforeSend)
      })
      const adding = addLocalRepoFromPath(store, path, 'folder')
      await (phase === 'send-stop'
        ? expect(adding).rejects.toThrow('unavailable')
        : expect(adding).resolves.toEqual({ repo: saved, alreadyExisted: true }))
      expect(mocks.ownerRepos).toEqual([])
      expect(store.addRepo).not.toHaveBeenCalled()
    }
  )

  it('groups an all-saved selection on Windows with the exact saved row, even in its extended spelling', async () => {
    const saved = row('saved-a', '\\\\?\\UNC\\wsl$\\Ubuntu\\home\\me\\a')
    const parentPath = '\\\\wsl$\\Ubuntu\\home\\me'
    const selected = `${parentPath}\\a`
    mocks.scan = scanOf(parentPath, [selected])
    const store = makeStore([saved])
    registerNestedRepoImportHandler(mainWindow, store)
    const result = await mocks.handlers.get('projectGroups:importNested')!(null, {
      parentPath,
      projectPaths: [selected],
      mode: 'group',
      scanId: 'scan-1'
    })
    expect(result).toMatchObject({
      alreadyKnownCount: 1,
      projects: [{ projectId: saved.id, status: 'already-known' }]
    })
    expect(store.moveProjectToGroup).toHaveBeenCalledWith(saved, 'local-group-1', 0)
    expect(store.addRepo).not.toHaveBeenCalled()
    expect(mocks.ensure).not.toHaveBeenCalled()
  })

  it.each(['complete', 'mixed', 'alias-failure', 'receipt-failure'] as const)(
    'retains truthful guest receipts and sparse old-peer grouping: %s',
    async (scenario) => {
      const parentPath = '\\\\wsl.localhost\\Ubuntu\\home\\me'
      const [web, api, late] = ['apps\\web', 'apps\\api', 'late'].map(
        (name) => `${parentPath}\\${name}`
      )
      mocks.scan = scanOf(parentPath, [web, api, late])
      const store = makeStore([])
      const normal = mocks.call.getMockImplementation()!
      mocks.call.mockImplementation(async (env, method, params, beforeSend) => {
        // Another window saves `late` on Windows while this import registers its siblings.
        if (scenario === 'mixed' && method === 'repo.add' && params.path === '/home/me/apps/web') {
          store.repos.push(row('late-windows', late))
        }
        if (
          scenario === 'alias-failure' &&
          method === 'projectGroup.moveProject' &&
          params.repo === 'id:guest:/home/me/apps/web'
        ) {
          throw new Error('Move failed')
        }
        if (scenario === 'receipt-failure' && method === 'projectHostSetup.list') {
          throw new Error('Setup read failed')
        }
        return normal(env, method, params, beforeSend)
      })
      if (scenario === 'alias-failure') {
        mocks.target = (path) => (path === api ? web : path)
      }
      registerNestedRepoImportHandler(mainWindow, store)
      const result = await mocks.handlers.get('projectGroups:importNested')!(null, {
        parentPath,
        projectPaths: [web, api, late],
        mode: 'group',
        scanId: 'scan-1'
      })
      const methods = mocks.call.mock.calls.map(([, method]) => method)
      expect(methods.every((method) => OLD_PEER_METHODS.has(method))).toBe(true)
      const groupCalls = mocks.call.mock.calls.filter(([, method]) =>
        method.startsWith('projectGroup.')
      )
      const statuses =
        scenario === 'complete'
          ? ['imported', 'imported', 'imported']
          : scenario === 'alias-failure'
            ? ['failed', 'failed', 'imported']
            : ['failed', 'failed', 'failed']
      const ids = [
        'guest:/home/me/apps/web',
        scenario === 'alias-failure' ? 'guest:/home/me/apps/web' : 'guest:/home/me/apps/api',
        scenario === 'mixed' ? 'late-windows' : 'guest:/home/me/late'
      ]
      expect(result).toMatchObject({
        importedCount: statuses.filter((status) => status === 'imported').length,
        failedCount: statuses.filter((status) => status === 'failed').length,
        projects: [web, api, late].map((path, index) => ({
          path,
          projectId: ids[index],
          status: statuses[index],
          executionHostId: scenario === 'mixed' && index === 2 ? 'local' : OWNER
        }))
      })
      if (scenario === 'mixed' || scenario === 'receipt-failure') {
        expect(groupCalls).toEqual([])
        expect(result).not.toHaveProperty('group')
      } else {
        expect(result).toMatchObject({ group: { id: 'guest-group-1', executionHostId: OWNER } })
        const moves = groupCalls.filter(([, method]) => method === 'projectGroup.moveProject')
        expect(moves).toHaveLength(scenario === 'alias-failure' ? 2 : 3)
        if (scenario === 'complete') {
          const layout = groupCalls.map(([, method, params]) =>
            method === 'projectGroup.create'
              ? ['create', params.name, params.parentPath, params.parentGroupId]
              : ['move', params.repo, params.groupId, params.order]
          )
          expect(layout).toEqual([
            ['create', 'me', '/home/me', null],
            ['create', 'apps', '/home/me/apps', 'guest-group-1'],
            ['move', 'id:guest:/home/me/apps/web', 'guest-group-2', 0],
            ['move', 'id:guest:/home/me/apps/api', 'guest-group-2', 1],
            ['move', 'id:guest:/home/me/late', 'guest-group-1', 2]
          ])
        }
      }
      expect(store.addRepo).not.toHaveBeenCalled()
    }
  )
})
