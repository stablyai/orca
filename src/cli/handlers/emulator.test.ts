import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { callMock, remoteMock } = vi.hoisted(() => ({
  callMock: vi.fn(),
  remoteMock: vi.fn(() => false)
}))

vi.mock('../runtime-client', async () => {
  class RuntimeClient {
    readonly isRemote: boolean
    call = callMock
    getCliStatus = vi.fn()
    openOrca = vi.fn()

    constructor() {
      this.isRemote = remoteMock()
    }
  }

  // Why: re-export the REAL error classes; format.ts narrows with `instanceof`
  // against ./runtime/types, so a look-alike would collapse every CLI error
  // code into the generic `runtime_error` shape.
  const { RuntimeClientError, RuntimeRpcFailureError } = await import('../runtime/types.js')
  return { RuntimeClient, RuntimeClientError, RuntimeRpcFailureError }
})

import { main } from '../index'
import { okFixture, queueFixtures } from '../test-fixtures'

describe('orca emulator CLI handlers', () => {
  const originalWorkspaceId = process.env.ORCA_WORKSPACE_ID
  const originalWorktreeId = process.env.ORCA_WORKTREE_ID

  beforeEach(() => {
    vi.restoreAllMocks()
    callMock.mockReset()
    remoteMock.mockReturnValue(false)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    process.exitCode = undefined
  })

  afterEach(() => {
    if (originalWorkspaceId === undefined) {
      delete process.env.ORCA_WORKSPACE_ID
    } else {
      process.env.ORCA_WORKSPACE_ID = originalWorkspaceId
    }
    if (originalWorktreeId === undefined) {
      delete process.env.ORCA_WORKTREE_ID
    } else {
      process.env.ORCA_WORKTREE_ID = originalWorktreeId
    }
  })

  it('resolves relative APK paths before calling the runtime', async () => {
    queueFixtures(callMock, okFixture('req_install', { ok: true }))

    await main(
      ['emulator', 'install', 'build/app.apk', '--reinstall', '--worktree', 'all'],
      '/repo/project'
    )

    expect(callMock).toHaveBeenCalledWith('emulator.install', {
      path: path.resolve('/repo/project', 'build/app.apk'),
      reinstall: true,
      device: undefined,
      emulator: undefined,
      worktree: undefined
    })
  })

  it('uses a wider client timeout for emulator attach recovery', async () => {
    queueFixtures(
      callMock,
      okFixture('req_attach', {
        attached: true,
        info: { deviceUdid: 'device-1', streamUrl: 'http://127.0.0.1:3102/stream.mjpeg' }
      })
    )

    await main(['emulator', 'attach', 'device-1', '--worktree', 'all'], '/repo/project')

    expect(callMock).toHaveBeenCalledWith(
      'emulator.attach',
      { device: 'device-1', worktree: undefined, focus: false },
      { timeoutMs: 180_000 }
    )
  })

  it('uses the folder workspace exported by the current Orca terminal', async () => {
    process.env.ORCA_WORKSPACE_ID = 'folder:folder-1'
    delete process.env.ORCA_WORKTREE_ID
    callMock.mockResolvedValue(
      okFixture('req_attach', {
        attached: true,
        info: { deviceUdid: 'device-1', streamUrl: 'scrcpy://device-1' }
      })
    )

    await main(['emulator', 'attach', 'device-1'], '/folder/project')

    expect(callMock).toHaveBeenCalledOnce()
    expect(callMock).toHaveBeenCalledWith(
      'emulator.attach',
      { device: 'device-1', worktree: 'folder:folder-1', focus: false },
      { timeoutMs: 180_000 }
    )
  })

  it('uses the current git worktree exported by the Orca terminal', async () => {
    process.env.ORCA_WORKSPACE_ID = 'folder:stale-parent'
    process.env.ORCA_WORKTREE_ID = 'repo-1::/repo/project '
    callMock.mockResolvedValue(
      okFixture('req_attach', {
        attached: true,
        info: { deviceUdid: 'device-1', streamUrl: 'scrcpy://device-1' }
      })
    )

    await main(['emulator', 'attach', 'device-1'], '/repo/project')

    expect(callMock).toHaveBeenCalledOnce()
    expect(callMock).toHaveBeenCalledWith(
      'emulator.attach',
      { device: 'device-1', worktree: 'repo-1::/repo/project ', focus: false },
      { timeoutMs: 180_000 }
    )
  })

  it('rejects relative APK paths for remote runtimes', async () => {
    remoteMock.mockReturnValue(true)

    await main(
      ['emulator', 'install', 'build/app.apk', '--pairing-code', 'remote', '--worktree', 'all'],
      '/repo/project'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect(vi.mocked(console.error).mock.calls[0][0]).toContain(
      'Remote emulator install requires --path to be an absolute path on the remote server.'
    )
    expect(process.exitCode).toBe(1)
  })

  it('preserves absolute server APK paths for remote runtimes', async () => {
    remoteMock.mockReturnValue(true)
    queueFixtures(callMock, okFixture('req_install', { ok: true }))

    await main(
      ['emulator', 'install', 'C:\\tmp\\app.apk', '--pairing-code', 'remote', '--worktree', 'all'],
      '/repo/project'
    )

    expect(callMock).toHaveBeenCalledWith('emulator.install', {
      path: 'C:\\tmp\\app.apk',
      reinstall: false,
      device: undefined,
      emulator: undefined,
      worktree: undefined
    })
  })

  it('allows device-wide permission reset without package or permission', async () => {
    queueFixtures(callMock, okFixture('req_permissions', { ok: true }))

    await main(['emulator', 'permissions', 'reset', '--worktree', 'all'], '/repo/project')

    expect(callMock).toHaveBeenCalledWith('emulator.permissions', {
      op: 'reset',
      package: undefined,
      permission: undefined,
      device: undefined,
      emulator: undefined,
      worktree: undefined
    })
  })

  it('rejects permission reset with package-like arguments', async () => {
    await main(
      ['emulator', 'permissions', 'reset', 'com.example.app', '--worktree', 'all'],
      '/repo/project'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect(vi.mocked(console.error).mock.calls[0][0]).toContain(
      'reset does not accept package or permission'
    )
    expect(process.exitCode).toBe(1)
  })

  it('rejects grant without a permission before calling the runtime', async () => {
    await main(
      ['emulator', 'permissions', 'grant', 'com.example.app', '--worktree', 'all'],
      '/repo/project'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect(vi.mocked(console.error).mock.calls[0][0]).toContain(
      '<permission> is required for grant'
    )
    expect(process.exitCode).toBe(1)
  })
})
