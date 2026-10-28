import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
import { okFixture, queueFixtures } from './test-fixtures'
import { useWorktreeAwarenessEnvironment } from './index-test-harness'

describe('orca cli repo add paths', () => {
  const priorExitCode = process.exitCode
  beforeEach(() => {
    process.exitCode = undefined
  })
  afterEach(() => {
    process.exitCode = priorExitCode
  })

  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  it('resolves repo.add paths against the invoking cli cwd', async () => {
    queueFixtures(
      callMock,
      okFixture('req_repo_add', {
        repo: {
          id: 'repo-1',
          path: path.resolve('/tmp/repo/apps/web'),
          displayName: 'web'
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['repo', 'add', '--path', './apps/web', '--json'], '/tmp/repo')

    expect(callMock).toHaveBeenCalledWith('repo.add', {
      path: path.resolve('/tmp/repo/apps/web')
    })
  })

  it('waits for first-use server setup when adding a local WSL path', async () => {
    queueFixtures(
      callMock,
      okFixture('req_repo_add', {
        repo: {
          id: 'guest',
          path: '/home/me/repo',
          displayName: 'repo',
          executionHostId: 'runtime:wsl:ubuntu'
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const repoPath = '\\\\wsl$\\Ubuntu\\home\\me\\repo'
    await main(['repo', 'add', '--path', repoPath, '--json'], '/tmp')
    // Why: the budget follows the resolved path, which is only a UNC path on Windows.
    const resolved = path.resolve('/tmp', repoPath)
    const budget = process.platform === 'win32' ? [{ timeoutMs: 600_000 }] : []
    expect(callMock).toHaveBeenCalledWith('repo.add', { path: resolved }, ...budget)
  })

  it('rejects remote repo.add relative paths instead of resolving against client cwd', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(
      ['repo', 'add', '--path', './apps/web', '--pairing-code', 'remote-runtime', '--json'],
      '/tmp/repo'
    )

    expect(callMock).not.toHaveBeenCalled()
    const printed = [...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')
    expect(JSON.parse(printed)).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(printed).toContain(
      'Remote repo add requires --path to be an absolute path on the remote server.'
    )
    expect(process.exitCode).toBe(1)
  })

  it('sends remote repo.add absolute paths unchanged', async () => {
    queueFixtures(
      callMock,
      okFixture('req_repo_add', {
        repo: {
          id: 'repo-1',
          path: '/srv/orca/web',
          displayName: 'web'
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['repo', 'add', '--path', '/srv/orca/web', '--pairing-code', 'remote-runtime', '--json'],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith('repo.add', {
      path: '/srv/orca/web'
    })
  })

  it.each(['C:\\repo', 'C:/repo', '\\\\server\\share\\repo', '//server/share/repo'])(
    'sends remote repo.add server absolute path %s unchanged',
    async (serverPath) => {
      queueFixtures(
        callMock,
        okFixture('req_repo_add', {
          repo: {
            id: 'repo-1',
            path: serverPath,
            displayName: 'web'
          }
        })
      )
      vi.spyOn(console, 'log').mockImplementation(() => {})

      await main(
        ['repo', 'add', '--path', serverPath, '--pairing-code', 'remote-runtime', '--json'],
        '/tmp/repo'
      )

      expect(callMock).toHaveBeenCalledWith('repo.add', {
        path: serverPath
      })
    }
  )
})
