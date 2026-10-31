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

const REPO_ADD_FIXTURE = okFixture('req_repo_add', {
  repo: {
    id: 'repo-1',
    path: path.resolve('/tmp/repo-tree'),
    displayName: 'repo-tree'
  }
})

describe('orca repo add --kind', () => {
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

  it('defaults to git when --kind is omitted', async () => {
    queueFixtures(callMock, REPO_ADD_FIXTURE)
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['repo', 'add', '--path', '/tmp/repo-tree', '--json'], '/tmp')

    expect(callMock).toHaveBeenCalledWith('repo.add', {
      path: path.resolve('/tmp/repo-tree'),
      kind: 'git'
    })
  })

  it('sends folder kind to the runtime', async () => {
    queueFixtures(callMock, REPO_ADD_FIXTURE)
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['repo', 'add', '--path', '/tmp/repo-tree', '--kind', 'folder', '--json'], '/tmp')

    expect(callMock).toHaveBeenCalledWith('repo.add', {
      path: path.resolve('/tmp/repo-tree'),
      kind: 'folder'
    })
  })

  it('refuses an unknown kind before reaching the runtime', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(['repo', 'add', '--path', '/tmp/repo-tree', '--kind', 'svn', '--json'], '/tmp')

    expect(callMock).not.toHaveBeenCalled()
    const printed = [...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')
    expect(JSON.parse(printed)).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(printed).toContain('--kind must be git or folder')
    expect(process.exitCode).toBe(1)
  })

  it('refuses an explicitly empty --kind instead of defaulting to git', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(['repo', 'add', '--path', '/tmp/repo-tree', '--kind=', '--json'], '/tmp')

    expect(callMock).not.toHaveBeenCalled()
    const printed = [...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')
    expect(JSON.parse(printed)).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(printed).toContain('Missing value for --kind')
    expect(process.exitCode).toBe(1)
  })
})
