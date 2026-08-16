import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock, tryGlabOnSshHostMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  tryGlabOnSshHostMock: vi.fn()
}))

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
  execFileSync: vi.fn(),
  spawn: vi.fn()
}))

vi.mock('./glab-ssh-execution', () => ({
  tryGlabOnSshHost: tryGlabOnSshHostMock
}))

import { glabExecFileAsync } from './runner'

describe('glabExecFileAsync SSH execution host routing', () => {
  beforeEach(() => {
    execFileMock.mockReset()
    tryGlabOnSshHostMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('uses the local path when no sshTargetId is provided', async () => {
    execFileMock.mockImplementation((_bin, _args, _opts, cb) => {
      cb(null, { stdout: 'local', stderr: '' })
    })

    await expect(glabExecFileAsync(['auth', 'status'])).resolves.toEqual({
      stdout: 'local',
      stderr: ''
    })
    expect(tryGlabOnSshHostMock).not.toHaveBeenCalled()
  })

  it('uses remote result when tryGlabOnSshHost succeeds', async () => {
    tryGlabOnSshHostMock.mockResolvedValueOnce({ stdout: 'remote-mr', stderr: '' })
    const controller = new AbortController()

    await expect(
      glabExecFileAsync(['mr', 'view', '1'], {
        sshTargetId: 'ssh-1',
        remoteCwd: '/remote/repo',
        signal: controller.signal
      })
    ).resolves.toEqual({ stdout: 'remote-mr', stderr: '' })

    expect(tryGlabOnSshHostMock).toHaveBeenCalledWith(
      ['mr', 'view', '1'],
      expect.objectContaining({
        sshTargetId: 'ssh-1',
        remoteCwd: '/remote/repo',
        signal: controller.signal
      })
    )
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('falls back to local exec when remote path returns null', async () => {
    tryGlabOnSshHostMock.mockResolvedValueOnce(null)
    execFileMock.mockImplementation((_bin, _args, _opts, cb) => {
      cb(null, { stdout: 'local-fallback', stderr: '' })
    })

    await expect(
      glabExecFileAsync(['api', 'user'], { sshTargetId: 'ssh-1', remoteCwd: '/repo' })
    ).resolves.toEqual({ stdout: 'local-fallback', stderr: '' })

    expect(tryGlabOnSshHostMock).toHaveBeenCalled()
    expect(execFileMock).toHaveBeenCalled()
  })
})
