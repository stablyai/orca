import { describe, expect, it, vi } from 'vitest'
import type { WorkspacePort } from '../shared/workspace-ports'

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

vi.mock('./runtime/environments', () => ({
  addEnvironmentFromPairingCode: addEnvironmentFromPairingCodeMock,
  listEnvironments: listEnvironmentsMock,
  removeEnvironment: vi.fn(),
  resolveEnvironment: vi.fn()
}))

vi.mock('child_process', async () => {
  const { createChildProcessModuleMock } = await import('./index-test-harness.js')
  return createChildProcessModuleMock(spawnMock)
})

import { main } from './index'
import { RuntimeClientError, RuntimeRpcFailureError } from './runtime-client'
import { buildWorktree, okFixture, queueFixtures, worktreeListFixture } from './test-fixtures'
import { useWorktreeAwarenessEnvironment } from './index-test-harness'

const FEATURE_ID = 'repo::/tmp/repo/feature'

function workspacePort(
  port: number,
  worktreeId: string,
  extra: { advertisedUrl?: string; confidence?: 'cwd' | 'command' } = {}
): WorkspacePort {
  return {
    id: `127.0.0.1:${port}:${port + 1}`,
    bindHost: '127.0.0.1',
    connectHost: 'localhost',
    port,
    pid: port + 1,
    processName: 'node',
    protocol: 'http',
    kind: 'workspace',
    owner: {
      worktreeId,
      repoId: 'repo',
      displayName: worktreeId.endsWith('feature') ? 'feature' : 'other',
      path: worktreeId.split('::')[1],
      confidence: extra.confidence ?? 'cwd'
    },
    ...(extra.advertisedUrl ? { advertisedUrl: extra.advertisedUrl } : {})
  }
}

const externalPort: WorkspacePort = {
  id: '0.0.0.0:5432:77',
  bindHost: '0.0.0.0',
  connectHost: 'localhost',
  port: 5432,
  pid: 77,
  processName: 'postgres',
  protocol: 'unknown',
  kind: 'external'
}

const hostScan = okFixture('req_scan', {
  executionHostId: 'local',
  platform: 'darwin',
  scannedAt: 1,
  ports: [
    workspacePort(5173, FEATURE_ID, { advertisedUrl: 'http://dev.test:5173' }),
    workspacePort(3000, FEATURE_ID, { confidence: 'command' }),
    workspacePort(4000, 'repo::/tmp/repo/other'),
    externalPort
  ]
})

const noFolders = okFixture('req_folders', { folderWorkspaces: [] })

function folderCatalog(folderPath: string): ReturnType<typeof okFixture>[] {
  return [
    okFixture('req_folders', {
      folderWorkspaces: [{ id: 'f1', folderPath, projectGroupId: 'local' }]
    }),
    okFixture('req_groups', { groups: [{ id: 'local' }] }),
    okFixture('req_repos', { repos: [] })
  ]
}

function selectorNotFound(): RuntimeRpcFailureError {
  return new RuntimeRpcFailureError({
    id: 'req_show',
    ok: false,
    error: { code: 'selector_not_found', message: 'selector_not_found' },
    _meta: { runtimeId: 'test-runtime' }
  })
}

function captureOutput(): () => string {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  return () => [...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')
}

describe('orca ports', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  it('scans the host of the worktree containing cwd and keeps only its ports', async () => {
    queueFixtures(
      callMock,
      noFolders,
      worktreeListFixture([
        buildWorktree('/tmp/repo', 'main'),
        buildWorktree('/tmp/repo/feature', 'feature/foo')
      ]),
      okFixture('req_show', { worktree: buildWorktree('/tmp/repo/feature', 'feature/foo') }),
      hostScan
    )
    const output = captureOutput()

    await main(['ports', '--json'], '/tmp/repo/feature/src')

    expect(callMock).toHaveBeenCalledTimes(4)
    expect(callMock).toHaveBeenNthCalledWith(3, 'worktree.show', { worktree: `id:${FEATURE_ID}` })
    expect(callMock).toHaveBeenNthCalledWith(4, 'workspacePorts.scanHost', {
      worktree: `id:${FEATURE_ID}`
    })
    const printed = JSON.parse(output())
    expect(printed.result.executionHostId).toBe('local')
    expect(printed.result.ports.map((port: WorkspacePort) => port.port)).toEqual([3000, 5173])
    expect(printed.result.ports[1].advertisedUrl).toBe('http://dev.test:5173')
  })

  it('prints one row per port with pid, process, host, protocol, match, and url', async () => {
    queueFixtures(
      callMock,
      noFolders,
      worktreeListFixture([buildWorktree('/tmp/repo/feature', 'feature/foo')]),
      okFixture('req_show', { worktree: buildWorktree('/tmp/repo/feature', 'feature/foo') }),
      hostScan
    )
    const output = captureOutput()

    await main(['ports'], '/tmp/repo/feature')

    expect(output()).toBe(
      [
        '3000  pid=3001  node  localhost  http  match=command',
        '5173  pid=5174  node  localhost  http  match=cwd  url=http://dev.test:5173',
        '',
        'host=local'
      ].join('\n')
    )
  })

  it('resolves an explicit selector to its worktree id before filtering', async () => {
    queueFixtures(
      callMock,
      okFixture('req_show', { worktree: buildWorktree('/tmp/repo/other', 'other') }),
      hostScan
    )
    const output = captureOutput()

    await main(['ports', '--worktree', 'branch:other', '--json'], '/tmp')

    expect(callMock).toHaveBeenNthCalledWith(1, 'worktree.show', { worktree: 'branch:other' })
    expect(callMock).toHaveBeenNthCalledWith(2, 'workspacePorts.scanHost', {
      worktree: 'branch:other'
    })
    expect(JSON.parse(output()).result.ports.map((port: WorkspacePort) => port.port)).toEqual([
      4000
    ])
  })

  it('lists every listener on the host with its owner under --all', async () => {
    queueFixtures(
      callMock,
      noFolders,
      worktreeListFixture([buildWorktree('/tmp/repo/feature', 'feature/foo')]),
      hostScan
    )
    const output = captureOutput()

    await main(['ports', '--all'], '/tmp/repo/feature')

    expect(callMock).not.toHaveBeenCalledWith('worktree.show', expect.anything())

    expect(output().split('\n').slice(0, 4)).toEqual([
      '3000  workspace=feature  pid=3001  node  localhost  http  match=command',
      '4000  workspace=other  pid=4001  node  localhost  http  match=cwd',
      '5173  workspace=feature  pid=5174  node  localhost  http  match=cwd  url=http://dev.test:5173',
      '5432  workspace=(none)  pid=77  postgres  localhost  unknown'
    ])
  })

  it.each([
    ['a standalone native folder', '/tmp/folder', '/tmp/folder/src'],
    ['a native folder nested in a git worktree', '/tmp/repo/feature/docs', '/tmp/repo/feature/docs']
  ])(
    'refuses %s containing cwd unless --all asks for the host',
    async (_label, folderPath, cwd) => {
      queueFixtures(callMock, ...folderCatalog(folderPath))
      const output = captureOutput()
      const priorExitCode = process.exitCode

      await main(['ports', '--json'], cwd)

      expect(callMock).not.toHaveBeenCalledWith('workspacePorts.scanHost', expect.anything())
      expect(output()).toContain('does not tie ports to native folder workspaces')
      expect(process.exitCode).toBe(1)
      process.exitCode = priorExitCode

      queueFixtures(callMock, ...folderCatalog(folderPath), hostScan)
      await main(['ports', '--all'], cwd)

      expect(callMock).toHaveBeenCalledWith('workspacePorts.scanHost', { worktree: 'id:folder:f1' })
      expect(callMock).not.toHaveBeenCalledWith('worktree.list', expect.anything())
      expect(output()).toContain('5432  workspace=(none)  pid=77  postgres')
    }
  )

  it('recognises a path selector naming a native folder', async () => {
    queueFixtures(
      callMock,
      okFixture('req_folders', {
        folderWorkspaces: [{ id: 'f1', folderPath: '/tmp/folder', projectGroupId: 'local' }]
      })
    )
    callMock.mockRejectedValueOnce(selectorNotFound())
    const output = captureOutput()
    const priorExitCode = process.exitCode

    await main(['ports', '--worktree', 'path:/tmp/folder'], '/tmp')

    expect(callMock).not.toHaveBeenCalledWith('workspacePorts.scanHost', expect.anything())
    expect(output()).toContain('does not tie ports to native folder workspaces')
    expect(process.exitCode).toBe(1)
    process.exitCode = priorExitCode

    queueFixtures(
      callMock,
      okFixture('req_folders', {
        folderWorkspaces: [{ id: 'f1', folderPath: '/tmp/folder', projectGroupId: 'local' }]
      })
    )
    callMock.mockRejectedValueOnce(selectorNotFound())
    queueFixtures(callMock, hostScan)
    await main(['ports', '--worktree', 'path:/tmp/folder', '--all'], '/tmp')

    expect(callMock).toHaveBeenCalledWith('workspacePorts.scanHost', { worktree: 'id:folder:f1' })
  })

  it('refuses a path that a worktree and a folder workspace share', async () => {
    queueFixtures(
      callMock,
      okFixture('req_folders', {
        folderWorkspaces: [{ id: 'f1', folderPath: '/srv/app', projectGroupId: 'ssh' }]
      }),
      okFixture('req_show', { worktree: buildWorktree('/srv/app', 'main') })
    )
    const output = captureOutput()
    const priorExitCode = process.exitCode

    await main(['ports', '--worktree', 'path:/srv/app', '--all'], '/tmp')

    expect(callMock).not.toHaveBeenCalledWith('workspacePorts.scanHost', expect.anything())
    expect(output()).toContain('id:repo::/srv/app, folder:f1')
    expect(process.exitCode).toBe(1)
    process.exitCode = priorExitCode
  })

  it('keeps the ports of a folder workspace instance that shares its path with the owner', async () => {
    const instance = {
      ...buildWorktree('/tmp/repo/feature', 'feature/foo'),
      id: `${FEATURE_ID}::workspace:second`
    }
    queueFixtures(callMock, okFixture('req_show', { worktree: instance }), hostScan)
    const output = captureOutput()

    await main(['ports', '--worktree', `id:${instance.id}`, '--json'], '/tmp')

    expect(JSON.parse(output()).result.ports.map((port: WorkspacePort) => port.port)).toEqual([
      3000, 5173
    ])
  })

  it('adds the worktree id to owner names shared by two workspaces under --all', async () => {
    const twin = workspacePort(4000, 'repo2::/tmp/twin/feature')
    queueFixtures(
      callMock,
      okFixture('req_scan', {
        executionHostId: 'local',
        platform: 'darwin',
        scannedAt: 1,
        ports: [workspacePort(3000, FEATURE_ID), twin, externalPort]
      })
    )
    const output = captureOutput()

    await main(['ports', '--worktree', 'branch:feature', '--all'], '/tmp')

    expect(output().split('\n').slice(0, 3)).toEqual([
      `3000  workspace=feature (${FEATURE_ID})  pid=3001  node  localhost  http  match=cwd`,
      '4000  workspace=feature (repo2::/tmp/twin/feature)  pid=4001  node  localhost  http  match=cwd',
      '5432  workspace=(none)  pid=77  postgres  localhost  unknown'
    ])
  })

  it('shows why the scan could not run', async () => {
    queueFixtures(
      callMock,
      okFixture('req_scan', {
        executionHostId: 'ssh:box',
        platform: 'unknown',
        scannedAt: 1,
        ports: [],
        unavailableReason: 'Could not scan the SSH host.'
      })
    )
    const output = captureOutput()

    await main(['ports', '--worktree', 'folder:f1', '--all'], '/tmp')

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(output()).toBe('Port scan unavailable: Could not scan the SSH host.\nhost=ssh:box')
  })

  it('asks for an Orca update when the runtime predates the host-scoped scan', async () => {
    callMock.mockRejectedValueOnce(
      new RuntimeClientError('method_not_found', 'Unknown method: workspacePorts.scanHost')
    )
    const output = captureOutput()
    const priorExitCode = process.exitCode

    await main(['ports', '--worktree', 'id:repo::/tmp/repo/feature', '--all'], '/tmp')

    expect(output()).toContain('cannot list workspace ports yet. Update Orca')
    expect(process.exitCode).toBe(1)
    process.exitCode = priorExitCode
  })
})
