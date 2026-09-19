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

const FOLDER_PATH = '/tmp/notes'

async function rejectNextCallWith(code: string, message: string): Promise<void> {
  const { RuntimeRpcFailureError } = await import('./runtime/types.js')
  callMock.mockRejectedValueOnce(
    new RuntimeRpcFailureError({ id: 'req_repo_add', ok: false, error: { code, message } })
  )
}

function pathStatusFixture(status: { path: string; exists: boolean; reason?: string }) {
  return okFixture('req_path_status', { status })
}

function folderRepoFixture() {
  return okFixture('req_repo_add', {
    repo: { id: 'repo-1', path: FOLDER_PATH, displayName: 'notes', kind: 'folder' }
  })
}

describe('orca repo add project kind', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  it('registers a plain directory as a folder project once the runtime rejects it as non-git', async () => {
    await rejectNextCallWith('runtime_error', `Not a valid git repository: ${FOLDER_PATH}`)
    queueFixtures(
      callMock,
      pathStatusFixture({ path: FOLDER_PATH, exists: true }),
      folderRepoFixture()
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(['repo', 'add', '--path', FOLDER_PATH, '--json'], '/tmp')

    expect(callMock.mock.calls).toEqual([
      ['repo.add', { path: FOLDER_PATH }],
      ['folderWorkspace.getPathStatus', { scope: 'path', path: FOLDER_PATH }],
      ['repo.add', { path: FOLDER_PATH, kind: 'folder' }]
    ])
    expect(JSON.parse(logSpy.mock.calls[0]?.[0]).result.repo.kind).toBe('folder')
    expect(process.exitCode).toBe(priorExitCode)
  })

  // Why: folder registration accepts any absolute path, so a typo would otherwise become a project
  // pointing at nothing instead of the error the caller got before the fallback existed.
  it('refuses the folder fallback when the host reports no directory at the path', async () => {
    await rejectNextCallWith('runtime_error', `Not a valid git repository: ${FOLDER_PATH}`)
    queueFixtures(
      callMock,
      pathStatusFixture({ path: FOLDER_PATH, exists: false, reason: 'missing' })
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(['repo', 'add', '--path', FOLDER_PATH, '--json'], '/tmp')

    expect(callMock).toHaveBeenCalledTimes(2)
    expect(callMock).not.toHaveBeenCalledWith('repo.add', { path: FOLDER_PATH, kind: 'folder' })
    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain(
      'the host reports no directory there'
    )
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })

  // An Orca server without the path-status method cannot refute the path, and refusing on that
  // would make the fallback unusable against older hosts.
  it('still falls back when the host cannot answer the path-status probe', async () => {
    await rejectNextCallWith('runtime_error', `Not a valid git repository: ${FOLDER_PATH}`)
    await rejectNextCallWith('method_not_found', 'Unknown method: folderWorkspace.getPathStatus')
    queueFixtures(callMock, folderRepoFixture())
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['repo', 'add', '--path', FOLDER_PATH, '--json'], '/tmp')

    expect(callMock).toHaveBeenLastCalledWith('repo.add', { path: FOLDER_PATH, kind: 'folder' })
  })

  // `unavailable` and `ambiguous-connection` say the host could not look, not that the directory is
  // absent, and only a positive refutation is allowed to cancel an add the caller asked for.
  it.each(['unavailable', 'ambiguous-connection'])(
    'still registers the folder when the probe answers %s',
    async (reason) => {
      await rejectNextCallWith('runtime_error', `Not a valid git repository: ${FOLDER_PATH}`)
      queueFixtures(
        callMock,
        pathStatusFixture({ path: FOLDER_PATH, exists: false, reason }),
        folderRepoFixture()
      )
      vi.spyOn(console, 'log').mockImplementation(() => {})

      await main(['repo', 'add', '--path', FOLDER_PATH, '--json'], '/tmp')

      expect(callMock).toHaveBeenLastCalledWith('repo.add', { path: FOLDER_PATH, kind: 'folder' })
    }
  )

  it('keeps --kind git a hard requirement instead of downgrading the project', async () => {
    await rejectNextCallWith('runtime_error', `Not a valid git repository: ${FOLDER_PATH}`)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(['repo', 'add', '--path', FOLDER_PATH, '--kind', 'git', '--json'], '/tmp')

    expect(callMock.mock.calls).toEqual([['repo.add', { path: FOLDER_PATH, kind: 'git' }]])
    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain(
      'Not a valid git repository'
    )
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })

  it('skips the git attempt when --kind folder is explicit', async () => {
    queueFixtures(
      callMock,
      pathStatusFixture({ path: FOLDER_PATH, exists: true }),
      folderRepoFixture()
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['repo', 'add', '--path', FOLDER_PATH, '--kind', 'folder', '--json'], '/tmp')

    expect(callMock.mock.calls).toEqual([
      ['folderWorkspace.getPathStatus', { scope: 'path', path: FOLDER_PATH }],
      ['repo.add', { path: FOLDER_PATH, kind: 'folder' }]
    ])
  })

  it('refuses an explicit --kind folder at a path the host reports as missing', async () => {
    queueFixtures(
      callMock,
      pathStatusFixture({ path: FOLDER_PATH, exists: false, reason: 'not-directory' })
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(['repo', 'add', '--path', FOLDER_PATH, '--kind', 'folder', '--json'], '/tmp')

    expect(callMock).toHaveBeenCalledTimes(1)
    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain(
      'the host reports no directory there'
    )
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })

  it('retries nothing when the add fails for a reason other than the path not being git', async () => {
    await rejectNextCallWith('runtime_error', 'Project path must be an absolute path')
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(['repo', 'add', '--path', FOLDER_PATH, '--json'], '/tmp')

    expect(callMock).toHaveBeenCalledTimes(1)
    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain(
      'Project path must be an absolute path'
    )
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })

  // `--kind=` reaches the parser as an empty string, and reading it as "no kind given" would let a
  // damaged flag pick the kind by detection instead of failing the way a typo'd value does.
  it.each([
    ['worktree', '--kind must be git or folder'],
    ['', '--kind must be git or folder']
  ])(
    'rejects --kind %j before reaching the runtime',
    async (value: string, expectedMessage: string) => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const priorExitCode = process.exitCode

      await main(['repo', 'add', '--path', FOLDER_PATH, `--kind=${value}`, '--json'], '/tmp')

      expect(callMock).not.toHaveBeenCalled()
      expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain(
        expectedMessage
      )
      expect(process.exitCode).toBe(1)

      process.exitCode = priorExitCode
    }
  )

  it('rejects a --kind passed with no value at all', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(['repo', 'add', '--path', FOLDER_PATH, '--kind', '--json'], '/tmp')

    expect(callMock).not.toHaveBeenCalled()
    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain('--kind')
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })
})
