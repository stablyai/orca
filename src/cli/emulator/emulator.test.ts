import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { callMock, remoteMock } = vi.hoisted(() => ({
  callMock: vi.fn(),
  remoteMock: vi.fn(() => false)
}))

vi.mock('../runtime/client', async () => {
  class RuntimeClient {
    readonly isRemote: boolean
    call = callMock
    getCliStatus = vi.fn()
    openOrca = vi.fn()

    constructor() {
      this.isRemote = remoteMock()
    }
  }
  return { RuntimeClient }
})

import { main } from '../index'

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
