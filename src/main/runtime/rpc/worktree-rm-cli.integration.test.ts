import './unused-default-rpc-methods.test-fixture'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime'
import { partialRuntimeStore, storeRepo, storeWorktreeMeta } from '../runtime-store-partial-fixture'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import type { Repo } from '../../../shared/repo-types'
import type { HostWorktreeTarget } from '../../../shared/worktree/host-qualified-identity'
import type { RemoveWorktreeResult } from '../../../shared/worktree/create-types'
import type { CliStatusResult, RuntimeWorktreeRemoveResult } from '../../../shared/runtime-types'
import type { RuntimeRpcSuccess } from '../../../shared/runtime-rpc-envelope'
import * as appEnvironment from '../../../shared/app-environment'
import type { SshTarget } from '../../../shared/ssh-types'
import { orcadMigrationCutoverFixture } from '../../ssh/orcad-migration-cutover-fixture'
import { writeOrcadMigrationSourceCutover } from '../../ssh/orcad-migration-cutover-journal'
import { removalPtyProvider } from './worktree-rm-pty.test-fixture'
import { pairedRemovalReceiver } from './worktree-rm-paired.test-fixture'
import { addManagedOrcadEnvironment } from '../../../shared/runtime-environment-managed-orcad-store'
import { getRuntimeMetadataPath } from '../../../shared/runtime-bootstrap'
import { WorktreeRemove } from '../../../shared/rpc-contract/worktree-params'
import { UnixSocketTransport } from './unix-socket-transport'
import { RpcDispatcher } from './dispatcher'
import { WORKTREE_METHODS } from './methods/worktree'
import { STATUS_METHODS } from './methods/status'
import type { RpcRequest } from './core'
import { WorkspaceLifecycleQueue } from '../workspaces/workspace-lifecycle-queue'
import { installRealWorkerThreadChildProcesses } from '../../worker-thread-child-process/worker-thread-child-process-real.test-fixtures'
import { removeTree } from '../../../shared/windows-transient-lock-removal'
import {
  _resetPendingWorktreeRemovalsForTests,
  _settlePendingWorktreeRemovalsForTests,
  startBackgroundWorktreeRemoval,
  waitForPendingWorktreeRemoval
} from '../../worktree-background-removal'
import * as acceptance from '../../worktree-removal-acceptance-queue'
import { failedWorktreeRemovals, pendingWorktreeRemovals } from '../../worktree-removal-table'

installRealWorkerThreadChildProcesses()
const cliPath = '../../../cli/index'
const { main }: { main: (argv: string[], cwd: string) => Promise<void> } = await import(cliPath)
type RemovalClient = {
  call<TResult>(method: string, params: unknown): Promise<RuntimeRpcSuccess<TResult>>
  getCliStatus(): Promise<RuntimeRpcSuccess<CliStatusResult>>
}
const clientPath = '../../../cli/runtime/client'
const {
  RuntimeClient
}: {
  RuntimeClient: new (
    userDataPath: string,
    requestTimeoutMs: number,
    remotePairingCode: string | null,
    environmentSelector: string | null
  ) => RemovalClient
} = await import(clientPath)
const removalRequestPath = '../../../cli/handlers/worktree-removal-request'
const {
  requestWorktreeRemoval
}: {
  requestWorktreeRemoval: (
    client: RemovalClient,
    request: {
      worktree: string
      hostId: string
      force: boolean
      deleteBranch?: boolean
      runHooks: boolean
      allowFailedArchiveHook: boolean
    }
  ) => Promise<RuntimeRpcSuccess<RuntimeWorktreeRemoveResult>>
} = await import(removalRequestPath)
const exec = promisify(execFile)
const received = vi.fn<(method: string, params: unknown) => void>()
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
let client: RemovalClient
let runtime: RemovalRuntime
let dispatcher: RpcDispatcher
let supported = true
let afterShow: () => void | Promise<void> = () => {}
let beforeStatus: () => void | Promise<void> = () => {}
const stopped = vi.fn(async () => {})
const git = async (...args: string[]) => (await exec('git', args, { cwd: repoPath })).stdout.trim()
class RemovalRuntime extends OrcaRuntimeService {
  override readonly workspaceLifecycle = new WorkspaceLifecycleQueue()
  override async showManagedWorktree(selector: string) {
    const shown = await super.showManagedWorktree(selector)
    await afterShow()
    return shown
  }
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
async function dispatch(request: RpcRequest, legacy = !supported) {
  received(request.method, request.params)
  if (request.method === 'status.get') {
    await beforeStatus()
  }
  const projected =
    legacy && request.method === 'worktree.rm'
      ? { ...request, params: WorktreeRemove.omit({ deleteBranch: true }).parse(request.params) }
      : request
  const response = await dispatcher.dispatch(projected)
  if (legacy && request.method === 'status.get' && response.ok) {
    // Historical status is successful and has no branch capability; keep the real producer's other fields.
    const { capabilities: _capabilities, ...status } = runtime.getStatus()
    return { ...response, result: status }
  }
  return response
}
beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  directory = await realpath(await mkdtemp(join(tmpdir(), 'orca-cli-rm-')))
  repoPath = join(directory, 'repo')
  checkout = join(directory, 'checkout')
  id = `repo::${checkout}`
  supported = true
  received.mockClear()
  stopped.mockClear()
  afterShow = () => {}
  beforeStatus = () => {}
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
    void dispatch(request).then((response) => reply(JSON.stringify(response)))
  })
  await socket.start()
  await discover(endpoint)
  client = new RuntimeClient(directory, 5000, null, null)
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

it.each([false, true])('preserves legacy omitted-field metadata policy %s', async (preserve) => {
  meta[id].preserveBranchOnDelete = preserve
  await client.call('worktree.rm', { worktree: `id:${id}`, waitForBackgroundRemoval: true })
  expect(existsSync(checkout)).toBe(false)
  expect(await git('for-each-ref', '--format=%(refname:short)', 'refs/heads/task')).toBe(
    preserve ? 'task' : ''
  )
})

it('does not apply a failed record’s branch choice to a freshly registered checkout', async () => {
  failedWorktreeRemovals.set(id, {
    worktreeId: id,
    repoId: 'repo',
    repoPath,
    worktreePath: checkout,
    branch: 'old-task',
    head: '',
    deleteBranch: true,
    force: false,
    requestedAt: 1,
    failure: { message: 'old failure', failedAt: 2 }
  })
  await main(['worktree', 'rm', '--worktree', `id:${id}`, '--json'], repoPath)
  expect(process.exitCode).not.toBe(1)
  expect(existsSync(checkout)).toBe(false)
  expect(await git('for-each-ref', '--format=%(refname:short)', 'refs/heads/task')).toBe('task')
})

it.each([false, true])(
  'rechecks branch intent after acceptance-queue wait, accepted=%s',
  async (deleteBranch) => {
    const block = Promise.withResolvers<void>()
    const gitPending = Promise.withResolvers<RemoveWorktreeResult>()
    const run = vi.fn(() => gitPending.promise)
    const first = acceptance.runSerializedWorktreeRemovalAcceptance(repoPath, () => block.promise)
    const entering = vi.spyOn(acceptance, 'runSerializedWorktreeRemovalAcceptance')
    const request = runtime.removeManagedWorktree(`id:${id}`, {
      deleteBranch: !deleteBranch,
      waitForBackgroundRemoval: true
    })
    // Observe rejection immediately so the forced schedule cannot create an unhandled rejection.
    const refused = expect(request).rejects.toThrow('different branch choice')
    try {
      await vi.waitFor(() => expect(entering).toHaveBeenCalledOnce())
      void startBackgroundWorktreeRemoval({
        removal: {
          worktreeId: id,
          repoId: 'repo',
          repoPath,
          worktree: { path: checkout, branch: 'task', head: '' },
          deleteBranch,
          force: false
        },
        run,
        publish: () => {}
      })
      const record = pendingWorktreeRemovals.get(id)
      const joined = waitForPendingWorktreeRemoval(id, 'local', deleteBranch)
      expect(waitForPendingWorktreeRemoval(id, 'local')).toBe(joined)
      expect(joined).toBeDefined()
      block.resolve()
      await first
      await new Promise((resolve) => setImmediate(resolve))
      expect(pendingWorktreeRemovals.get(id)).toBe(record)
      expect(record?.deleteBranch).toBe(deleteBranch)
      expect(existsSync(checkout)).toBe(true)
      expect(await git('for-each-ref', '--format=%(refname:short)', 'refs/heads/task')).toBe('task')
      gitPending.resolve({})
      await refused
      await expect(joined).resolves.toEqual({})
      expect(run).toHaveBeenCalledOnce()
    } finally {
      block.resolve()
      gitPending.resolve({})
      await first
    }
  }
)

it('settles the same dirty-checkout refusal for omitted and explicit keep intent', async () => {
  await writeFile(join(checkout, 'file'), 'unsaved')
  const head = await git('rev-parse', 'task')
  const registered = await git('worktree', 'list', '--porcelain')
  const failures: string[] = []
  for (const deleteBranch of [undefined, false]) {
    const failure = await client
      .call('worktree.rm', {
        worktree: `id:${id}`,
        hostId: 'local',
        force: false,
        runHooks: false,
        allowUnverifiedPtyStop: false,
        allowFailedArchiveHook: false,
        ...(deleteBranch === undefined ? {} : { deleteBranch }),
        waitForBackgroundRemoval: true
      })
      .then(
        () => {
          throw new Error('Expected dirty refusal')
        },
        (error: unknown) => String(error)
      )
    failures.push(failure)
    expect(await readFile(join(checkout, 'file'), 'utf8')).toBe('unsaved')
    expect(await git('rev-parse', 'task')).toBe(head)
    expect(await git('worktree', 'list', '--porcelain')).toBe(registered)
    expect(pendingWorktreeRemovals.size).toBe(0)
  }
  expect(failures[0]).toContain('M file')
  expect(failures[1]).toBe(failures[0])
  expect(stopped).not.toHaveBeenCalled()
})

function legacyParams(worktree = `id:${id}`, hostId = 'local', force = false) {
  return {
    worktree,
    hostId,
    force,
    runHooks: false,
    allowFailedArchiveHook: false,
    allowUnverifiedPtyStop: force,
    waitForBackgroundRemoval: true
  }
}
function warnings() {
  return vi
    .mocked(console.error)
    .mock.calls.filter(([value]) => String(value).includes('host is older'))
}
it.each([false, true])('sends exact legacy params and one warning, JSON=%s', async (json) => {
  supported = false
  const args = ['worktree', 'rm', '--worktree', 'name:task', '--delete-branch', '--force']
  await main(json ? [...args, '--json'] : args, repoPath)
  expect(process.exitCode).not.toBe(1)
  expect(received.mock.calls.at(-1)).toEqual([
    'worktree.rm',
    legacyParams('name:task', 'local', true)
  ])
  expect(warnings()).toHaveLength(1)
  expect(existsSync(checkout)).toBe(false)
  expect(await git('for-each-ref', '--format=%(refname:short)', 'refs/heads/task')).toBe('')
  if (json) {
    expect(JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0]))).toMatchObject({
      ok: true,
      result: { removed: true }
    })
  }
})
it.each<{ capable: boolean; flags: string[]; root: boolean }>([
  { capable: true, flags: [], root: false },
  { capable: true, flags: ['--delete-branch'], root: false },
  { capable: false, flags: [], root: false },
  { capable: false, flags: [], root: true }
])(
  'uses actual folder producer/removal, capable=$capable root=$root flags=$flags',
  async ({ capable, flags, root }) => {
    supported = capable
    const folderId = root
      ? `folder-repo::${directory}`
      : `folder-repo::${directory}::workspace:00000000-0000-4000-8000-000000000001`
    const sibling = `folder-repo::${directory}::workspace:00000000-0000-4000-8000-000000000002`
    meta[folderId] = storeWorktreeMeta({ instanceId: 'folder-one', hostId: 'local' })
    meta[sibling] = storeWorktreeMeta({ instanceId: 'folder-two', hostId: 'local' })
    const own = `${folderId}@@own`
    const sessions = removalPtyProvider([
      { id: own, cwd: directory, title: 'shell', worktreeId: folderId },
      { id: `${sibling}@@other`, cwd: directory, title: 'shell', worktreeId: sibling }
    ])
    vi.spyOn(runtime, 'getLocalProvider').mockReturnValue(sessions.provider)
    const shown = await runtime.showManagedWorktree(`id:${folderId}`)
    expect(shown).not.toHaveProperty('workspaceKind')
    const cleanup = vi.spyOn(runtime, 'removeWorktreeMetadataAndHistory')
    const head = await git('rev-parse', 'task')
    await main(['worktree', 'rm', '--worktree', `id:${folderId}`, ...flags, '--json'], repoPath)
    expect(process.exitCode === 1).toBe(root)
    expect(cleanup).toHaveBeenCalledTimes(root ? 0 : 1)
    expect(sessions.shutdown).toHaveBeenCalledTimes(root ? 0 : 1)
    if (!root) {
      expect(sessions.shutdown).toHaveBeenCalledWith(own, expect.anything())
    }
    expect(Boolean(meta[folderId])).toBe(root)
    expect(meta[sibling]).toBeDefined()
    expect(existsSync(directory)).toBe(true)
    expect(await git('rev-parse', 'task')).toBe(head)
    expect(received.mock.calls.at(-1)).toEqual([
      'worktree.rm',
      {
        ...legacyParams(`id:${folderId}`),
        ...(capable ? { deleteBranch: flags.includes('--delete-branch') } : {})
      }
    ])
    expect(warnings()).toHaveLength(capable ? 0 : 1)
    const output = String(vi.mocked(console.log).mock.calls.at(-1)?.[0])
    expect(output).not.toContain('branch')
    if (root) {
      expect(output).toContain('root workspace')
    }
  }
)
it('sends the original selector after actual folder show and rename, with explicit keep for Git', async () => {
  const folderId = `folder-repo::${directory}::workspace:00000000-0000-4000-8000-000000000001`
  meta[folderId] = storeWorktreeMeta({
    displayName: 'target',
    instanceId: 'folder',
    hostId: 'local'
  })
  afterShow = () => {
    afterShow = () => {}
    meta[folderId].displayName = 'renamed'
    meta[id].displayName = 'target'
    runtime.invalidateResolvedWorktreeCache()
  }
  const head = await git('rev-parse', 'task')
  await main(['worktree', 'rm', '--worktree', 'name:target', '--json'], repoPath)
  expect(process.exitCode).not.toBe(1)
  expect(received.mock.calls.at(-1)).toEqual([
    'worktree.rm',
    { ...legacyParams('name:target'), deleteBranch: false }
  ])
  expect(meta[folderId]).toBeDefined()
  expect(meta[id]).toBeUndefined()
  expect(existsSync(checkout)).toBe(false)
  expect(await git('rev-parse', 'task')).toBe(head)
})
it('selects legacy on B after lookup on A and cannot rediscover C during B status', async () => {
  const kind = process.platform === 'win32' ? 'named-pipe' : 'unix'
  const endpoint =
    process.platform === 'win32'
      ? String.raw`\\.\pipe\orca-rm-${process.pid}-B`
      : join(directory, 'B.sock')
  const legacy = new UnixSocketTransport({ kind, endpoint })
  const methods: string[] = []
  legacy.onMessage((message, reply) => {
    const request: RpcRequest = JSON.parse(message)
    methods.push(request.method)
    void dispatch(request, true).then((response) => reply(JSON.stringify(response)))
  })
  try {
    await legacy.start()
    afterShow = async () => {
      afterShow = () => {}
      await discover(endpoint)
    }
    beforeStatus = async () => {
      await discover(join(directory, 'never-C.sock'))
    }
    await main(['worktree', 'rm', '--worktree', `id:${id}`, '--json'], repoPath)
    expect(process.exitCode).not.toBe(1)
    expect(methods).toEqual(['status.get', 'worktree.rm'])
    expect(received.mock.calls.at(-1)).toEqual(['worktree.rm', legacyParams()])
    expect(warnings()).toHaveLength(1)
    expect(existsSync(checkout)).toBe(false)
    expect(await git('for-each-ref', '--format=%(refname:short)', 'refs/heads/task')).toBe('')
  } finally {
    await legacy.stop()
  }
})
it('does not dispatch or replay after preflight disconnect', async () => {
  beforeStatus = () => socket.stop()
  const head = await git('rev-parse', 'task')
  await main(['worktree', 'rm', '--worktree', `id:${id}`, '--json'], repoPath)
  expect(process.exitCode).toBe(1)
  expect(received.mock.calls.map(([method]) => method)).toEqual(['worktree.show', 'status.get'])
  expect(existsSync(checkout)).toBe(true)
  expect(await git('rev-parse', 'task')).toBe(head)
  expect(warnings()).toHaveLength(0)
})

it.each([true, false])(
  'routes actual argv through a served SSH environment, capable=%s',
  async (capable) => {
    supported = capable
    const receiver = await pairedRemovalReceiver(dispatch)
    const clientRepo = join(directory, 'client-repo')
    try {
      await mkdir(clientRepo)
      await exec('git', ['init', '-q', clientRepo])
      await exec('git', [
        '-C',
        clientRepo,
        '-c',
        'user.name=Client',
        '-c',
        'user.email=client@example.invalid',
        'commit',
        '--allow-empty',
        '-qm',
        'client'
      ])
      const localHead = (await exec('git', ['-C', clientRepo, 'rev-parse', 'HEAD'])).stdout
      const head = await git('rev-parse', 'task')
      const environment = addManagedOrcadEnvironment(directory, {
        id: 'served-ssh',
        name: 'served-ssh',
        pairingCode: receiver.pairingCode,
        orcadDeployment: {
          sshTargetId: 'fixture-ssh',
          sshTargetGeneration: 1,
          localPort: receiver.port,
          remotePort: 6768
        }
      })
      await main(
        ['worktree', 'rm', '--environment', environment.id, '--worktree', `id:${id}`, '--json'],
        clientRepo
      )
      expect(process.exitCode, JSON.stringify(vi.mocked(console.log).mock.calls)).not.toBe(1)
      expect(receiver.connections).toEqual([
        ['status.get', 'worktree.show'],
        ['status.get', 'worktree.rm']
      ])
      expect(received.mock.calls.at(-1)).toEqual([
        'worktree.rm',
        { ...legacyParams(), ...(capable ? { deleteBranch: false } : {}) }
      ])
      expect(warnings()).toHaveLength(capable ? 0 : 1)
      expect(existsSync(checkout)).toBe(false)
      if (capable) {
        expect(await git('rev-parse', 'task')).toBe(head)
      } else {
        expect(await git('for-each-ref', '--format=%(refname:short)', 'refs/heads/task')).toBe('')
      }
      expect((await exec('git', ['-C', clientRepo, 'rev-parse', 'HEAD'])).stdout).toBe(localHead)
      // Runtime-local host spelling is translated by the actual receiving RPC method.
      await git('worktree', 'add', '-qb', 'second', checkout)
      runtime.invalidateResolvedWorktreeCache()
      const paired = new RuntimeClient(directory, 5000, receiver.pairingCode, null)
      await paired.getCliStatus()
      await requestWorktreeRemoval(paired, {
        worktree: `id:${id}`,
        hostId: `runtime:${environment.id}`,
        force: false,
        deleteBranch: false,
        runHooks: false,
        allowFailedArchiveHook: false
      })
      expect(existsSync(checkout)).toBe(false)
      expect(receiver.connections.at(-1)).toEqual(['status.get', 'worktree.rm'])
      expect(await git('rev-parse', 'main')).not.toBe('')
    } finally {
      await receiver.close()
    }
  }
)

it('retains legacy hidden SSH folder removal with a raw-ID local twin', async () => {
  supported = false
  sshTargets = [
    {
      id: 'source',
      label: 'Source',
      host: 'unused.invalid',
      port: 22,
      username: 'test',
      generation: 2,
      orcadFence: { environmentId: 'env-1' }
    }
  ]
  writeOrcadMigrationSourceCutover(directory, {
    ...orcadMigrationCutoverFixture('move', 'source'),
    phase: 'destination-committed'
  })
  const hidden = storeRepo({ ...folderRepo, connectionId: 'source' })
  repos = [repo, folderRepo, hidden]
  const folderId = `folder-repo::${directory}::workspace:11111111-1111-4111-8111-111111111111`
  meta[folderId] = storeWorktreeMeta({
    hostId: 'ssh:source',
    instanceId: '11111111-1111-4111-8111-111111111111'
  })
  expect(runtime.listVisibleRepos()).not.toContainEqual(hidden)
  expect(runtime.listRepos()).toContainEqual(hidden)
  expect(await runtime.showManagedWorktree(`id:${folderId}`)).toMatchObject({
    id: folderId,
    hostId: 'ssh:source'
  })
  const head = await git('rev-parse', 'task')
  await main(['worktree', 'rm', '--worktree', `id:${folderId}`, '--json'], repoPath)
  expect(process.exitCode, JSON.stringify(vi.mocked(console.log).mock.calls)).not.toBe(1)
  expect(received.mock.calls.at(-1)).toEqual([
    'worktree.rm',
    legacyParams(`id:${folderId}`, 'ssh:source')
  ])
  expect(meta[folderId]).toBeUndefined()
  expect(repos).toContain(folderRepo)
  expect(existsSync(directory)).toBe(true)
  expect(await git('rev-parse', 'task')).toBe(head)
  expect(warnings()).toHaveLength(1)
})

it('keeps the legacy warning on JSON refusal without implying branch success', async () => {
  supported = false
  await writeFile(join(checkout, 'file'), 'unsaved')
  const head = await git('rev-parse', 'task')
  await main(['worktree', 'rm', '--worktree', `id:${id}`, '--delete-branch', '--json'], repoPath)
  expect(process.exitCode).toBe(1)
  expect(warnings()).toHaveLength(1)
  const output = JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0]))
  expect(output).toMatchObject({ ok: false })
  expect(output).not.toHaveProperty('result')
  expect(await readFile(join(checkout, 'file'), 'utf8')).toBe('unsaved')
  expect(await git('rev-parse', 'task')).toBe(head)
  expect(runtime.workspaceLifecycle.hints()).toEqual({})
})

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
