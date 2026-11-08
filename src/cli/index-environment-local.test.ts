import { describe, expect, it, vi } from 'vitest'

const {
  callMock,
  runtimeClientConstructorMock,
  serveOrcaAppMock,
  getDefaultUserDataPathMock,
  addEnvironmentFromPairingCodeMock,
  listEnvironmentsMock,
  resolveEnvironmentMock,
  spawnMock
} = vi.hoisted(() => ({
  callMock: vi.fn(),
  runtimeClientConstructorMock: vi.fn(),
  serveOrcaAppMock: vi.fn(),
  getDefaultUserDataPathMock: vi.fn(() => '/tmp/orca-user-data'),
  addEnvironmentFromPairingCodeMock: vi.fn(),
  listEnvironmentsMock: vi.fn(),
  resolveEnvironmentMock: vi.fn(),
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

vi.mock('./runtime/environments', () => ({
  addEnvironmentFromPairingCode: addEnvironmentFromPairingCodeMock,
  removeEnvironment: vi.fn(),
  resolveEnvironment: resolveEnvironmentMock
}))

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
import { buildWorktree, okFixture, worktreeListFixture } from './test-fixtures'

const SAVED = [
  { id: 'srv-b', name: 'build-box' },
  { id: 'srv-old', name: 'local' }
].map((environment) => ({
  ...environment,
  createdAt: 1,
  updatedAt: 1,
  lastUsedAt: null,
  runtimeId: null,
  endpoints: [],
  preferredEndpointId: null
}))

async function run(args: string[], cwd = '/tmp/repo') {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  const err = vi.spyOn(console, 'error').mockImplementation(() => {})
  const prior = process.exitCode
  await main(args, cwd)
  const exitCode = process.exitCode
  process.exitCode = prior
  const output = [...log.mock.calls, ...err.mock.calls].flat().join('\n')
  log.mockRestore()
  err.mockRestore()
  return { exitCode, output }
}

describe('--environment local and workspace addresses', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  it.each([
    [['worktree', 'ps', '--pairing-code', 'orca://pair?code=x', '--environment', 'local']],
    [['worktree', 'ps', '--host', 'runtime:srv-b', '--environment', 'local']],
    [['environment', 'add', '--name', ' Local ', '--pairing-code', 'orca://pair?code=x']],
    [['environment', 'stop', '--environment', 'local']]
  ])('refuses %j before any request', async (args) => {
    listEnvironmentsMock.mockReturnValue(SAVED)
    const { exitCode, output } = await run([...args, '--json'])
    expect(exitCode).toBe(1)
    expect(JSON.parse(output).error.code).toBe('invalid_argument')
    expect(callMock).not.toHaveBeenCalled()
    expect(addEnvironmentFromPairingCodeMock).not.toHaveBeenCalled()
    if (args[0] === 'environment' && args[1] === 'stop') {
      expect(output).toContain('--environment srv-old')
    }
  })

  it('refuses current against another environment with an inspection command', async () => {
    listEnvironmentsMock.mockReturnValue(SAVED)
    const { exitCode, output } = await run([
      'worktree',
      'current',
      '--environment',
      'srv-b',
      '--json'
    ])
    expect(exitCode).toBe(1)
    expect(JSON.parse(output).error.data.nextSteps[0]).toContain(
      '`orca worktree ps --environment srv-b --json`'
    )
    expect(callMock).not.toHaveBeenCalled()
  })

  it('resolves current under --environment local to the folder workspace at cwd', async () => {
    vi.stubEnv('ORCA_ENVIRONMENT', 'srv-b')
    listEnvironmentsMock.mockReturnValue(SAVED)
    callMock.mockImplementation(async (method: string) => {
      if (method === 'worktree.list') {
        return worktreeListFixture([])
      }
      if (method === 'folderWorkspace.list') {
        return okFixture('folders', {
          folderWorkspaces: [{ id: 'hub-a', folderPath: '/tmp/hub', projectGroupId: 'group' }]
        })
      }
      if (method === 'projectGroup.list') {
        return okFixture('groups', { groups: [{ id: 'group' }] })
      }
      if (method === 'repo.list') {
        return okFixture('repos', { repos: [] })
      }
      return okFixture('show', { worktree: { id: 'folder:hub-a', path: '/tmp/hub' } })
    })
    const { exitCode, output } = await run(
      ['worktree', 'current', '--environment', 'local', '--json'],
      '/tmp/hub/notes'
    )
    expect(exitCode).toBeUndefined()
    expect(callMock).toHaveBeenCalledWith('worktree.show', { worktree: 'folder:hub-a' })
    expect(JSON.parse(output).result.worktree.address.line).toBe(
      '--environment local --worktree folder:hub-a'
    )
    vi.unstubAllEnvs()
  })

  it('surfaces a folder-catalog failure for an omitted target instead of using runtime focus', async () => {
    callMock.mockImplementation(async (method: string) => {
      if (method === 'worktree.list') {
        return worktreeListFixture([buildWorktree('/tmp/hub/repo', 'main')])
      }
      if (method === 'folderWorkspace.list') {
        throw new RuntimeClientError('runtime_unavailable', 'folder catalog connection closed')
      }
      return okFixture('accepted', { marker: 'accepted' })
    })
    const { exitCode, output } = await run(['snapshot', '--json'], '/tmp/hub/repo/src')
    expect(exitCode).toBe(1)
    expect(JSON.parse(output).error.code).toBe('runtime_unavailable')
    expect(callMock).not.toHaveBeenCalledWith('browser.snapshot', expect.anything())
  })

  it('refuses omitted and explicit current when the enclosing folder host is unknown', async () => {
    callMock.mockImplementation(async (method: string) => {
      if (method === 'worktree.list') {
        return worktreeListFixture([])
      }
      if (method === 'folderWorkspace.list') {
        return okFixture('folders', {
          folderWorkspaces: [{ id: 'hub-a', folderPath: '/tmp/hub', projectGroupId: 'group' }]
        })
      }
      if (method === 'projectGroup.list' || method === 'repo.list') {
        throw new RuntimeClientError('method_not_found', 'Unknown method')
      }
      return okFixture('accepted', { marker: 'accepted' })
    })
    for (const args of [['snapshot'], ['worktree', 'current']]) {
      const { exitCode, output } = await run([...args, '--json'], '/tmp/hub/notes')
      expect(exitCode).toBe(1)
      expect(JSON.parse(output).error.code).toBe('selector_ambiguous')
      expect(output).toContain(
        'Pass --worktree folder:hub-a to target the folder workspace itself.'
      )
    }
    expect(callMock).not.toHaveBeenCalledWith('browser.snapshot', expect.anything())
    expect(callMock).not.toHaveBeenCalledWith('worktree.show', expect.anything())
  })

  it('surfaces a worktree-list method_not_found for an omitted target', async () => {
    callMock.mockImplementation(async (method: string) => {
      if (method === 'worktree.list') {
        throw new RuntimeClientError('method_not_found', 'Unknown method: worktree.list')
      }
      return okFixture('accepted', { folderWorkspaces: [], marker: 'accepted' })
    })
    const { exitCode, output } = await run(['snapshot', '--json'], '/tmp/hub/repo/src')
    expect(exitCode).toBe(1)
    expect(JSON.parse(output).error.code).toBe('method_not_found')
    expect(callMock).not.toHaveBeenCalledWith('browser.snapshot', expect.anything())
  })
})

describe('worktree rm needs an explicit workspace', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  const root = buildWorktree('/tmp/rm-repo', 'main')
  const sibling = { ...root, id: `${root.id}::workspace:sibling` }

  it.each(['current', 'active'])(
    'refuses --worktree %s, naming what it resolves to, and removes nothing',
    async (value) => {
      for (const [rows, resolution, selectors] of [
        [[root], 'resolved', ['id:repo::/tmp/rm-repo']],
        [
          [root, sibling],
          'ambiguous',
          ['id:repo::/tmp/rm-repo', 'id:repo::/tmp/rm-repo::workspace:sibling']
        ],
        [[], 'unresolved', []]
      ] as const) {
        callMock.mockReset()
        callMock.mockImplementation(async (method: string) =>
          method === 'worktree.list'
            ? worktreeListFixture([...rows])
            : okFixture('folders', { folderWorkspaces: [] })
        )
        const { exitCode, output } = await run(
          ['worktree', 'rm', '--worktree', value, '--force', '--json'],
          '/tmp/rm-repo/src'
        )
        expect(exitCode).toBe(1)
        const { error } = JSON.parse(output)
        expect(error.code).toBe('invalid_argument')
        expect(error.message).toContain(
          `orca worktree rm needs an explicit workspace; --worktree ${value} is not accepted`
        )
        expect(error.data.current).toEqual({ resolution, selectors: [...selectors] })
        expect(error.data.nextSteps.slice(0, selectors.length)).toEqual(
          selectors.map((selector) => `orca worktree rm --worktree ${selector}`)
        )
        if (resolution === 'resolved') {
          expect(error.message).toContain(`Here, ${value} is --worktree id:repo::/tmp/rm-repo`)
        }
        const methods = callMock.mock.calls.map(([method]) => method)
        expect(methods).not.toContain('worktree.show')
        expect(methods).not.toContain('worktree.rm')
      }
    }
  )

  it.each(['current', 'active'])(
    'refuses --worktree %s inside a folder workspace before the folder removal path',
    async (value) => {
      callMock.mockReset()
      callMock.mockImplementation(async (method: string) => {
        if (method === 'worktree.list') {
          return worktreeListFixture([])
        }
        if (method === 'folderWorkspace.list') {
          return okFixture('folders', {
            folderWorkspaces: [{ id: 'hub-a', folderPath: '/tmp/hub', projectGroupId: 'group' }]
          })
        }
        if (method === 'projectGroup.list') {
          return okFixture('groups', { groups: [{ id: 'group' }] })
        }
        return okFixture('repos', { repos: [] })
      })
      const { exitCode, output } = await run(
        ['worktree', 'rm', '--worktree', value, '--json'],
        '/tmp/hub/notes'
      )
      expect(exitCode).toBe(1)
      const { error } = JSON.parse(output)
      expect(error.code).toBe('invalid_argument')
      expect(error.data.current).toEqual({ resolution: 'resolved', selectors: ['folder:hub-a'] })
      expect(error.data.nextSteps[0]).toBe('orca worktree rm --worktree folder:hub-a')
      const methods = callMock.mock.calls.map(([method]) => method)
      expect(methods).not.toContain('folderWorkspace.delete')
      expect(methods).not.toContain('worktree.show')
    }
  )

  it('keeps the environment-specific guidance when the target is another environment', async () => {
    listEnvironmentsMock.mockReturnValue(SAVED)
    const { exitCode, output } = await run([
      'worktree',
      'rm',
      '--worktree',
      'current',
      '--environment',
      'srv-b',
      '--json'
    ])
    expect(exitCode).toBe(1)
    expect(JSON.parse(output).error.data.nextSteps[0]).toContain(
      '`orca worktree ps --environment srv-b --json`'
    )
    expect(callMock).not.toHaveBeenCalled()
  })
})
