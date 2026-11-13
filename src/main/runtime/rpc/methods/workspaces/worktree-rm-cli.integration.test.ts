import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../../orca-runtime'
import {
  partialRuntimeStore,
  storeRepo,
  storeWorktreeMeta
} from '../../../orca-runtime-tests/runtime-store-partial-fixture'
import type { WorktreeMeta } from '../../../../../shared/worktree/meta-types'
import type { Repo } from '../../../../../shared/repo-types'
import type { HostWorktreeTarget } from '../../../../../shared/worktree/host-qualified-identity'

import * as appEnvironment from '../../../../../shared/app-environment'
import type { SshTarget } from '../../../../../shared/ssh-types'

import { getRuntimeMetadataPath } from '../../../../../shared/runtime-bootstrap'

import { UnixSocketTransport } from '../../transports/unix-socket-transport'
import { RpcDispatcher } from '../../dispatcher'
import { WORKTREE_METHODS } from './worktree'
import { STATUS_METHODS } from '../host-management/status'
import type { RpcRequest } from '../../core'
import { WorkspaceLifecycleQueue } from '../../../workspaces/lifecycle/workspace-lifecycle-queue'
import { installRealWorkerThreadChildProcesses } from '../../../../worker-thread-child-process/worker-thread-child-process-real.test-fixtures'
import { removeTree } from '../../../../../shared/windows-transient-lock-removal'
import {
  _resetPendingWorktreeRemovalsForTests,
  _settlePendingWorktreeRemovalsForTests,
  loadWorktreeRemovalRecords
} from '../../../../workspaces/removal/worktree-background-removal'

installRealWorkerThreadChildProcesses()
const cliPath = '../../../../../cli/index'
const { main }: { main: (argv: string[], cwd: string) => Promise<void> } = await import(cliPath)

const exec = promisify(execFile)
let directory = ''
let repoPath = ''
let checkout = ''
let id = ''
let repo: Repo
let folderRepo: Repo
let repos: Repo[]
let sshTargets: SshTarget[]
let meta: Record<string, WorktreeMeta>
let socket: UnixSocketTransport
let runtime: RemovalRuntime
let dispatcher: RpcDispatcher
const stopped = vi.fn(async () => {})
const git = async (...args: string[]) => (await exec('git', args, { cwd: repoPath })).stdout.trim()
class RemovalRuntime extends OrcaRuntimeService {
  override readonly workspaceLifecycle = new WorkspaceLifecycleQueue()
}
async function discover(endpoint: string) {
  await writeFile(
    getRuntimeMetadataPath(directory),
    JSON.stringify({
      runtimeId: runtime.getRuntimeId(),
      pid: process.pid,
      transports: [{ kind: process.platform === 'win32' ? 'named-pipe' : 'unix', endpoint }],
      authToken: 'test',
      startedAt: 1
    })
  )
}
beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  directory = await realpath(await mkdtemp(join(tmpdir(), 'orca-cli-rm-')))
  await loadWorktreeRemovalRecords(directory)
  repoPath = join(directory, 'repo')
  checkout = join(directory, 'checkout')
  id = `repo::${checkout}`
  stopped.mockClear()
  vi.stubEnv('ORCA_USER_DATA_PATH', directory)
  vi.stubEnv('ORCA_PAIRING_CODE', '')
  vi.stubEnv('ORCA_REMOTE_PAIRING', '')
  vi.stubEnv('ORCA_ENVIRONMENT', '')
  await mkdir(repoPath)
  await git('init', '-q')
  await git('checkout', '-qb', 'main')
  await git('config', 'user.email', 'rm@example.invalid')
  await git('config', 'user.name', 'CLI Removal')
  await git('config', 'maintenance.auto', 'false')
  await git('config', 'gc.auto', '0')
  await writeFile(join(repoPath, 'file'), 'seed')
  await git('add', '.')
  await git('commit', '-qm', 'seed')
  await git('worktree', 'add', '-qb', 'task', checkout)
  await writeFile(join(checkout, 'file'), 'task change')
  await git('-C', checkout, 'commit', '-qam', 'task')
  await git('merge', '--squash', 'task')
  await git('commit', '-qm', 'squashed task')
  repo = storeRepo({ id: 'repo', path: repoPath })
  folderRepo = storeRepo({ id: 'folder-repo', path: directory, kind: 'folder' })
  repos = [repo, folderRepo]
  sshTargets = []
  vi.spyOn(appEnvironment, 'getAppEnvironment').mockReturnValue({
    getPath: () => directory,
    getAppPath: () => directory,
    getVersion: () => 'test',
    isPackaged: () => false,
    onWillQuit: () => {},
    exit: () => {},
    getAppMetrics: () => []
  })
  meta = { [id]: storeWorktreeMeta({ displayName: 'task', instanceId: 'task', hostId: 'local' }) }
  const store = partialRuntimeStore({
    getRepos: () => repos,
    getSshTargets: () => sshTargets,
    getRepo: (repoId) => repos.find((r) => r.id === repoId),
    getAllWorktreeMeta: () => meta,
    getWorktreeMeta: (key) => meta[key],
    setWorktreeMeta: ({ id: key }: HostWorktreeTarget, value: Partial<WorktreeMeta>) =>
      (meta[key] = { ...storeWorktreeMeta(), ...meta[key], ...value }),
    removeWorktreeMeta: ({ id: key }: HostWorktreeTarget) => {
      delete meta[key]
    },
    getAllWorktreeLineage: () => ({}),
    getAllWorkspaceLineage: () => ({}),
    getProjects: () => [],
    getProfileStorageDirectory: () => directory,
    getRetiredWorktreeNameRegistry: () => ({ exhaustedTiers: 0, names: [] }),
    addRetiredWorktreeName: () => {},
    mergeRetiredWorktreeNames: () => false,
    flushOrThrow: () => {}
  })
  runtime = new RemovalRuntime(store)
  vi.spyOn(runtime, 'machineNameReady').mockResolvedValue(undefined)
  vi.spyOn(runtime, 'acquireFileWatcherRemoval').mockResolvedValue({ finish: async () => {} })
  vi.spyOn(runtime, 'closeFileWatchersForRemoval').mockResolvedValue(undefined)
  vi.spyOn(runtime, 'stopPtysForDestructiveWorktreeRemoval').mockImplementation(stopped)
  vi.spyOn(runtime, 'notifyWorktreesChanged').mockImplementation(() => {})
  dispatcher = new RpcDispatcher({ runtime, methods: [...STATUS_METHODS, ...WORKTREE_METHODS] })
  const kind = process.platform === 'win32' ? 'named-pipe' : 'unix'
  const endpoint =
    process.platform === 'win32'
      ? String.raw`\\.\pipe\orca-rm-${process.pid}`
      : join(directory, 'rpc.sock')
  socket = new UnixSocketTransport({ kind, endpoint })
  socket.onMessage((message, reply) => {
    const request: RpcRequest = JSON.parse(message)
    void dispatcher.dispatch(request).then((response) => reply(JSON.stringify(response)))
  })
  await socket.start()
  await discover(endpoint)
})
afterEach(async () => {
  await _settlePendingWorktreeRemovalsForTests()
  _resetPendingWorktreeRemovalsForTests()
  await socket?.stop()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  process.exitCode = 0
  await removeTree(directory)
})

it.each<{ flags: string[]; deleted: boolean }>([
  { flags: [], deleted: false },
  { flags: ['--force'], deleted: false },
  { flags: ['--delete-branch'], deleted: true }
])(
  'runs CLI $flags through actual RPC/runtime/background Git, deleted=$deleted',
  async ({ flags, deleted }) => {
    // Existing branches have preservation metadata; explicit opt-in must override it.
    meta[id].preserveBranchOnDelete = flags.includes('--delete-branch')
    const head = await git('rev-parse', 'task')
    await main(['worktree', 'rm', '--worktree', `id:${id}`, ...flags, '--json'], repoPath)
    expect(process.exitCode).not.toBe(1)
    await _settlePendingWorktreeRemovalsForTests()
    expect(existsSync(checkout)).toBe(false)
    expect(await git('for-each-ref', '--format=%(refname:short)', 'refs/heads/task')).toBe(
      deleted ? '' : 'task'
    )
    if (!deleted) {
      expect(await git('rev-parse', 'task')).toBe(head)
    }
  }
)

function warnings() {
  return vi
    .mocked(console.error)
    .mock.calls.filter(([value]) => String(value).includes('host is older'))
}

it('reports actual safe branch preservation when forced checkout removal cannot delete the branch', async () => {
  await writeFile(join(checkout, 'unmerged'), 'only on task')
  await git('-C', checkout, 'add', 'unmerged')
  await git('-C', checkout, 'commit', '-qm', 'unmerged')
  const head = await git('rev-parse', 'task')
  await main(['worktree', 'rm', '--worktree', `id:${id}`, '--delete-branch', '--force'], repoPath)
  expect(process.exitCode).not.toBe(1)
  expect(existsSync(checkout)).toBe(false)
  expect(await git('rev-parse', 'task')).toBe(head)
  expect(vi.mocked(console.log)).toHaveBeenCalledWith('removed: true')
  expect(vi.mocked(console.error)).toHaveBeenCalledWith(
    'warning: local branch "task" was kept because Git could not safely delete it'
  )
  expect(warnings()).toHaveLength(0)
})
