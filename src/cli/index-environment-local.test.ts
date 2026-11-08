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

function psRow(fields: Record<string, unknown>) {
  return {
    repoId: 'repo',
    repo: 'repo',
    branch: 'main',
    isArchived: false,
    isMainWorktree: false,
    parentWorktreeId: null,
    childWorktreeIds: [],
    unread: false,
    liveTerminalCount: 0,
    hasAttachedPty: false,
    lastOutputAt: null,
    preview: '',
    status: 'inactive',
    agents: [],
    ...fields
  }
}

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

  it('routes --environment local to this machine over an ambient environment or pairing code', async () => {
    for (const [name, value] of [
      ['ORCA_ENVIRONMENT', 'srv-b'],
      ['ORCA_PAIRING_CODE', 'orca://pair?code=ambient-secret']
    ]) {
      vi.stubEnv(name, value)
      listEnvironmentsMock.mockReturnValue(SAVED)
      runtimeClientConstructorMock.mockClear()
      callMock.mockReset()
      callMock.mockResolvedValue(
        okFixture('ps', {
          worktrees: [
            psRow({
              worktreeId: 'repo::/tmp/repo',
              path: '/tmp/repo',
              hostId: 'local',
              identity: { key: 'wt2:local:abc' }
            })
          ],
          totalCount: 1,
          truncated: false
        })
      )
      const { exitCode, output } = await run(['worktree', 'ps', '--environment', 'local', '--json'])
      expect(exitCode).toBeUndefined()
      expect(runtimeClientConstructorMock).toHaveBeenCalledWith(null, null)
      expect(JSON.parse(output).result.worktrees[0]).toMatchObject({
        hostId: 'local',
        environment: { id: 'local', name: 'local' },
        address: {
          environment: 'local',
          worktree: 'identity:wt2:local:abc',
          line: '--environment local --worktree identity:wt2:local:abc'
        },
        parent: null
      })
      vi.unstubAllEnvs()
    }
  })

  it('lets an explicit --environment win over a stale ORCA_ENVIRONMENT', async () => {
    vi.stubEnv('ORCA_ENVIRONMENT', 'removed-entry')
    listEnvironmentsMock.mockReturnValue(SAVED)
    callMock.mockResolvedValue(okFixture('ps', { worktrees: [], totalCount: 0, truncated: false }))
    const { exitCode } = await run(['worktree', 'ps', '--environment', 'srv-b', '--json'])
    expect(exitCode).toBeUndefined()
    expect(runtimeClientConstructorMock).toHaveBeenLastCalledWith(undefined, 'srv-b')
    expect(resolveEnvironmentMock).not.toHaveBeenCalled()
    vi.unstubAllEnvs()
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

  it('gives a one-off pairing-code connection no address and never prints the code', async () => {
    vi.stubEnv('ORCA_PAIRING_CODE', 'orca://pair?code=one-off-secret')
    callMock.mockResolvedValue(
      okFixture('ps', {
        worktrees: [psRow({ worktreeId: 'repo::/srv/app', path: '/srv/app', hostId: 'local' })],
        totalCount: 1,
        truncated: false
      })
    )
    for (const json of [true, false]) {
      const { output } = await run(['worktree', 'ps', ...(json ? ['--json'] : [])])
      expect(output).not.toContain('one-off-secret')
      if (json) {
        expect(JSON.parse(output).result.worktrees[0]).toMatchObject({
          environment: { id: null, name: null },
          address: null,
          addressUnavailable: 'one-off-connection'
        })
      } else {
        expect(output).toContain('environment: one-off connection\naddress: unavailable')
      }
    }
    vi.unstubAllEnvs()
  })

  it('names each parent environment and never guesses a route', async () => {
    listEnvironmentsMock.mockReturnValue(SAVED)
    runtimeClientConstructorMock.mockClear()
    const crossStore = (installationId: string, workspaceKey: string) => ({
      parent: { installationId, workspaceKey, instanceId: 'parent-instance' }
    })
    callMock.mockImplementation(async (method: string) => {
      if (method === 'worktree.lineageList') {
        return okFixture('lineage', { installationId: 'install-local' })
      }
      return okFixture('ps', {
        worktrees: [
          psRow({
            worktreeId: 'repo::/srv/api',
            path: '/srv/api',
            hostId: 'local',
            identity: { key: 'wt2:local:api' },
            crossStoreParent: crossStore('install-local', 'folder:hub-a')
          }),
          psRow({
            worktreeId: 'repo::/srv/web',
            path: '/srv/web',
            hostId: 'local',
            identity: { key: 'wt2:local:web' },
            crossStoreParent: crossStore('install-c', 'folder:hub-c')
          }),
          psRow({
            worktreeId: 'repo::/srv/orphan',
            path: '/srv/orphan',
            hostId: 'runtime:unresolved-owner',
            identity: { key: 'wt2:runtime%3Aunresolved-owner:x' }
          }),
          ...['/srv/one', '/srv/two'].map((path) =>
            psRow({
              workspaceKind: 'folder-workspace',
              worktreeId: 'folder:twin',
              path,
              hostId: 'local'
            })
          )
        ],
        totalCount: 5,
        truncated: false
      })
    })
    const { output: json } = await run(['worktree', 'ps', '--environment', 'build-box', '--json'])
    const [api, web, orphan, twinA, twinB] = JSON.parse(json).result.worktrees
    expect(api).toMatchObject({
      environment: { id: 'srv-b', name: 'build-box' },
      address: { line: '--environment srv-b --worktree identity:wt2:local:api' },
      parent: {
        state: 'known',
        selector: 'folder:hub-a',
        environment: { id: 'local', name: 'local' },
        address: { environment: 'local', worktree: 'folder:hub-a' }
      }
    })
    expect(web.parent).toEqual({
      state: 'unknown-environment',
      selector: 'folder:hub-c',
      environment: null,
      address: null
    })
    expect(orphan).toMatchObject({
      hostId: 'runtime:unresolved-owner',
      environment: { id: 'srv-b' },
      address: null,
      addressUnavailable: 'unverifiable-row'
    })
    expect([twinA.addressUnavailable, twinB.addressUnavailable]).toEqual([
      'duplicate-folder-id',
      'duplicate-folder-id'
    ])
    // Only this machine's own Orca is asked; no other environment is dialed.
    expect(runtimeClientConstructorMock.mock.calls).toEqual([
      [undefined, 'build-box'],
      [null, null]
    ])

    const { output: text } = await run(['worktree', 'ps', '--environment', 'build-box'])
    expect(text).toContain(
      '/srv/api\nparent: folder:hub-a  environment=local\nenvironment: build-box\naddress: --environment srv-b --worktree identity:wt2:local:api'
    )
    expect(text).toContain('parent: folder:hub-c  environment=unknown (no verified route here)')
    expect(text).toContain('host=runtime:unresolved-owner')
  })

  it('gives a duplicated folder parent no address, as its own rows have none', async () => {
    callMock.mockResolvedValue(
      okFixture('ps', {
        worktrees: [
          psRow({
            worktreeId: 'repo::/srv/child',
            path: '/srv/child',
            hostId: 'local',
            identity: { key: 'wt2:local:child' },
            workspaceLineage: { parentWorkspaceKey: 'folder:duplicated' }
          }),
          ...(['local', 'ssh:box'] as const).map((hostId) =>
            psRow({
              workspaceKind: 'folder-workspace',
              worktreeId: 'folder:duplicated',
              path: '/srv/shared',
              hostId
            })
          )
        ],
        totalCount: 3,
        truncated: false
      })
    )
    const { output } = await run(['worktree', 'ps', '--json'])
    const [child, ...parents] = JSON.parse(output).result.worktrees
    expect(parents.map((row: { addressUnavailable: string }) => row.addressUnavailable)).toEqual([
      'duplicate-folder-id',
      'duplicate-folder-id'
    ])
    expect(child.parent).toEqual({
      state: 'known',
      selector: 'folder:duplicated',
      environment: { id: 'local', name: 'local' },
      address: null
    })
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

  it('quotes address values for the shell', async () => {
    const row = buildWorktree('/tmp/my repo', 'main')
    callMock.mockResolvedValue(okFixture('show', { worktree: { ...row, hostId: 'local' } }))
    const { output } = await run(['worktree', 'show', '--worktree', `id:${row.id}`, '--json'])
    expect(JSON.parse(output).result.worktree.address).toEqual({
      environment: 'local',
      worktree: 'id:repo::/tmp/my repo',
      line:
        process.platform === 'win32'
          ? '--environment local --worktree "id:repo::/tmp/my repo"'
          : "--environment local --worktree 'id:repo::/tmp/my repo'"
    })
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
