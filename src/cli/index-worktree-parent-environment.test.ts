import { describe, expect, it, vi } from 'vitest'

const {
  callMock,
  runtimeClientConstructorMock,
  serveOrcaAppMock,
  getDefaultUserDataPathMock,
  addEnvironmentFromPairingCodeMock,
  listEnvironmentsMock,
  spawnMock
} = vi.hoisted(() => ({
  callMock: vi.fn(),
  runtimeClientConstructorMock: vi.fn(),
  serveOrcaAppMock: vi.fn(),
  getDefaultUserDataPathMock: vi.fn(() => '/tmp/orca-user-data'),
  addEnvironmentFromPairingCodeMock: vi.fn(),
  listEnvironmentsMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('./runtime-client', async () => {
  const { createRuntimeClientModuleMock } = await import('./index-test-harness.js')
  return createRuntimeClientModuleMock({
    callMock,
    runtimeClientConstructorMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock
  })
})

vi.mock('../shared/remote-runtime/host-store/runtime-environment-store', () => ({
  listEnvironments: listEnvironmentsMock
}))

vi.mock('child_process', async () => {
  const { createChildProcessModuleMock } = await import('./index-test-harness.js')
  return createChildProcessModuleMock(spawnMock)
})

import { main } from './index'
import { useWorktreeAwarenessEnvironment } from './index-test-harness'
import { RuntimeClientError } from './runtime/types'
import { buildWorktree, okFixture } from './test-fixtures'

const SAVED = [
  { id: 'srv-b', name: 'build-box' },
  { id: 'srv-c', name: 'gpu-box' }
].map((environment) => ({
  ...environment,
  createdAt: 1,
  updatedAt: 1,
  lastUsedAt: null,
  runtimeId: null,
  endpoints: [],
  preferredEndpointId: null
}))

const CROSS_MACHINE = 'worktree.lineage.crossMachine'

type Call = { environment: string; method: string; params: Record<string, unknown> }
type Answer = (call: Call) => unknown

/** Answers each request by the environment its client routes to; `local` is the caller's Orca. */
function serve(answer: Answer): Call[] {
  const calls: Call[] = []
  callMock.mockImplementation(async function (
    this: { environmentSelector: string | null },
    method: string,
    params: Record<string, unknown> = {}
  ) {
    const call = { environment: this.environmentSelector ?? 'local', method, params }
    calls.push(call)
    const result = answer(call)
    if (result instanceof Error) {
      throw result
    }
    if (result !== undefined) {
      return okFixture(method, result)
    }
    if (method === 'status.get') {
      return okFixture(method, { capabilities: [CROSS_MACHINE, 'worktree.set.folder-parent.v1'] })
    }
    if (method === 'worktree.create' || method === 'worktree.set') {
      return okFixture(method, { worktree: buildWorktree('/srv/child', 'child', 'abc', 'repo-1') })
    }
    if (method === 'worktree.lineageList') {
      return okFixture(method, { installationId: `install-${call.environment}` })
    }
    return okFixture(method, {})
  })
  return calls
}

const FOLDER_PARENT: Answer = ({ method, params }) =>
  method === 'worktree.show' && params.worktree === 'folder:hub-a'
    ? { worktree: { id: 'folder:hub-a', path: '/Users/me/Projects Hub' } }
    : undefined

const MUTATIONS = new Set(['worktree.create', 'worktree.set'])

async function run(args: string[], cwd = '/tmp/elsewhere') {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  const err = vi.spyOn(console, 'error').mockImplementation(() => {})
  const prior = process.exitCode
  await main([...args, '--json'], cwd)
  const exitCode = process.exitCode
  process.exitCode = prior
  const output = [...log.mock.calls, ...err.mock.calls].flat().join('\n')
  log.mockRestore()
  err.mockRestore()
  return { exitCode, output }
}

describe('--parent-environment', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  it('creates on B under a folder on this machine, recorded as a cross-store ref', async () => {
    listEnvironmentsMock.mockReturnValue(SAVED)
    const calls = serve(FOLDER_PARENT)
    const { exitCode } = await run([
      'worktree',
      'create',
      '--environment',
      'srv-b',
      '--repo',
      'id:repo-1',
      '--name',
      'child',
      '--parent-environment',
      'local',
      '--parent-worktree',
      'folder:hub-a'
    ])
    expect(exitCode).toBeUndefined()
    const create = calls.find((call) => call.method === 'worktree.create')
    expect(create?.environment).toBe('srv-b')
    expect(create?.params.crossStoreParent).toEqual({
      installationId: 'install-local',
      workspaceKey: 'folder:hub-a',
      instanceId: 'hub-a'
    })
    expect(create?.params).not.toHaveProperty('parentWorkspace')
    expect(create?.params).not.toHaveProperty('parentWorktree')
  })

  it('resolves the parent on C and records it on B by saved name', async () => {
    listEnvironmentsMock.mockReturnValue(SAVED)
    const calls = serve(({ environment, method, params }) =>
      environment === 'srv-c' && method === 'worktree.show' && params.worktree === 'name:trunk'
        ? { worktree: { id: 'repo-9::/gpu/trunk', instanceId: 'inst-trunk' } }
        : undefined
    )
    const { exitCode } = await run([
      'worktree',
      'set',
      '--environment',
      'srv-b',
      '--worktree',
      'id:repo-1::/srv/child',
      '--parent-environment',
      'gpu-box',
      '--parent-worktree',
      'name:trunk'
    ])
    expect(exitCode).toBeUndefined()
    expect(
      calls.find((call) => call.method === 'worktree.show' && call.environment === 'srv-c')?.params
    ).toEqual({ worktree: 'name:trunk', matchFolderWorkspaces: true })
    const set = calls.find((call) => call.method === 'worktree.set')
    expect(set?.environment).toBe('srv-b')
    expect(set?.params.crossStoreParent).toEqual({
      installationId: 'install-srv-c',
      workspaceKey: 'worktree:repo-9::/gpu/trunk',
      instanceId: 'inst-trunk'
    })
  })

  it('by default looks only in the child environment and says where it looked', async () => {
    listEnvironmentsMock.mockReturnValue(SAVED)
    const calls = serve(({ method }) =>
      method === 'worktree.set'
        ? new RuntimeClientError('LINEAGE_PARENT_NOT_FOUND', 'Parent not found.')
        : undefined
    )
    const { exitCode, output } = await run([
      'worktree',
      'set',
      '--environment',
      'srv-b',
      '--worktree',
      'id:repo-1::/srv/child',
      '--parent-worktree',
      'folder:hub-a'
    ])
    expect(exitCode).toBe(1)
    const error = JSON.parse(output).error
    expect(error.code).toBe('LINEAGE_PARENT_NOT_FOUND')
    expect(error.data.environment).toBe('srv-b')
    expect(error.data.nextSteps.join('\n')).toContain('--parent-environment')
    expect(new Set(calls.map((call) => call.environment))).toEqual(new Set(['srv-b']))
  })

  it('refuses a caller-relative parent in another environment before any request', async () => {
    listEnvironmentsMock.mockReturnValue(SAVED)
    const calls = serve(() => undefined)
    const { output } = await run([
      'worktree',
      'create',
      '--repo',
      'id:repo-1',
      '--name',
      'child',
      '--parent-environment',
      'srv-b',
      '--parent-worktree',
      'current'
    ])
    expect(JSON.parse(output).error.code).toBe('invalid_argument')
    expect(calls).toEqual([])
  })

  it('refuses --parent-environment without a parent or with --no-parent', async () => {
    listEnvironmentsMock.mockReturnValue(SAVED)
    const calls = serve(() => undefined)
    for (const parentFlags of [['--no-parent'], []]) {
      const { output } = await run([
        'worktree',
        'set',
        '--worktree',
        'id:repo-1::/srv/child',
        '--parent-environment',
        'srv-b',
        ...parentFlags
      ])
      expect(JSON.parse(output).error.code).toBe('invalid_argument')
    }
    expect(calls).toEqual([])
  })

  it('fails each preflight before any mutating request', async () => {
    listEnvironmentsMock.mockReturnValue(SAVED)
    const setOnB = (parentEnvironment: string) => [
      'worktree',
      'set',
      '--environment',
      'srv-b',
      '--worktree',
      'id:repo-1::/srv/child',
      '--parent-environment',
      parentEnvironment,
      '--parent-worktree',
      'folder:hub-a'
    ]
    const cases: [string, string, Answer][] = [
      ['srv-z', 'environment_not_paired', FOLDER_PARENT],
      [
        'srv-c',
        'environment_unavailable',
        ({ environment }) =>
          environment === 'srv-c'
            ? new RuntimeClientError('remote_runtime_unavailable', 'Could not connect.')
            : undefined
      ],
      [
        'local',
        'incompatible_runtime',
        (call) =>
          call.method === 'status.get' && call.environment === 'srv-b'
            ? { capabilities: [] }
            : FOLDER_PARENT(call)
      ],
      [
        'local',
        'LINEAGE_PARENT_NOT_FOUND',
        ({ method }) =>
          method === 'worktree.show'
            ? new RuntimeClientError('selector_not_found', 'No match.')
            : undefined
      ]
    ]
    for (const [parentEnvironment, code, answer] of cases) {
      const calls = serve(answer)
      const { output } = await run(setOnB(parentEnvironment))
      expect(JSON.parse(output).error.code, parentEnvironment).toBe(code)
      expect(calls.filter((call) => MUTATIONS.has(call.method))).toEqual([])
      if (code === 'environment_not_paired') {
        expect(calls).toEqual([])
      }
    }
  })
})
