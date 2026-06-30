import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { callMock, remoteMock } = vi.hoisted(() => ({
  callMock: vi.fn(),
  remoteMock: vi.fn(() => false)
}))

vi.mock('../runtime-client', () => {
  class RuntimeClient {
    readonly isRemote: boolean
    call = callMock
    getCliStatus = vi.fn()
    openOrca = vi.fn()

    constructor() {
      this.isRemote = remoteMock()
    }
  }

  class RuntimeClientError extends Error {
    readonly code: string

    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  }

  class RuntimeRpcFailureError extends RuntimeClientError {
    readonly response: unknown

    constructor(response: unknown) {
      super('runtime_error', 'runtime_error')
      this.response = response
    }
  }

  return {
    RuntimeClient,
    RuntimeClientError,
    RuntimeRpcFailureError
  }
})

import { main } from '../index'
import { okFixture, queueFixtures } from '../test-fixtures'

describe('orca emulator CLI handlers', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    callMock.mockReset()
    remoteMock.mockReturnValue(false)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    process.exitCode = undefined
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
