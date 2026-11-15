import { createFakeSpawnedChild } from '../../../../shared/__fixtures__/fake-spawned-child'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Keep this protocol fixture on the synchronous POSIX launch leg.
const restorePlatform = vi.hoisted(() => {
  const platform = process.platform
  if (platform === 'darwin') {
    Object.defineProperty(process, 'platform', { value: 'linux' })
  }
  return () => Object.defineProperty(process, 'platform', { value: platform })
})
afterAll(restorePlatform)

const { spawnMock, execFileMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  execFileMock: vi.fn()
}))
const captureMock = process.platform === 'win32' ? execFileMock : spawnMock
vi.mock('node:child_process', async (original) => ({
  ...(await original()),
  spawn: spawnMock,
  execFile: execFileMock
}))

import { gitExecFileAsync } from '../git-exec-file'
import { GitAdmissionScheduler } from '../../../../shared/git/admission/git-admission-scheduler'
import { _resetGitAdmissionForTests } from '../admission/git-subprocess-admission'

beforeEach(() => {
  spawnMock.mockReset()
  execFileMock.mockReset()
})
afterEach(() => _resetGitAdmissionForTests())

describe('network Git SSH policy', () => {
  it('admits the core.sshCommand probe before spawning it', async () => {
    const scheduler = new GitAdmissionScheduler({ generalCap: 1, generalHeadroom: 0 })
    _resetGitAdmissionForTests(scheduler)
    const blocker = await scheduler.acquire({ args: ['status'], cwd: '/repo', tier: 'status' })
    const calls: string[][] = []
    captureMock.mockImplementation((_cmd, args, _options, callback) => {
      const child = createFakeSpawnedChild(1234 + calls.length)
      calls.push(args)
      queueMicrotask(() => {
        callback?.(null, '', '')
        child.emit('close', 0, null)
      })
      return child
    })

    const pending = gitExecFileAsync(['fetch', '--no-write-fetch-head', 'origin'], {
      cwd: '/repo',
      env: {},
      useConfiguredSshCommandForNetwork: true
    })
    await Promise.resolve()
    expect(captureMock).not.toHaveBeenCalled()

    blocker.release()
    await pending

    expect(calls).toEqual([
      ['config', '--null', '--get-regexp', '^(core\\.sshcommand|ssh\\.variant)$'],
      ['fetch', '--no-write-fetch-head', 'origin']
    ])
  })

  it.each(['ETIMEDOUT', 'ENOBUFS', 'ABORT_ERR'])(
    'does not select a generic SSH command after a %s config failure',
    async (code) => {
      const error = Object.assign(new Error('SSH configuration unavailable'), { code })
      captureMock.mockImplementation((_cmd, _args, _options, callback) => {
        const child = createFakeSpawnedChild()
        Object.defineProperty(child, 'pid', { value: undefined })
        queueMicrotask(() => {
          callback?.(error, '', '')
          child.emit('error', error)
        })
        return child
      })
      await expect(gitExecFileAsync(['fetch', 'origin'], { cwd: '/repo', env: {} })).rejects.toBe(
        error
      )
      expect(captureMock).toHaveBeenCalledTimes(1)
      expect(captureMock.mock.calls[0]?.[1]?.[0]).toBe('config')
    }
  )
})
