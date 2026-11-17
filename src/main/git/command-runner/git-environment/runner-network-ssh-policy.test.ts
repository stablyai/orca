import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }))
vi.mock('node:child_process', () => ({
  execFile: execFileMock,
  execFileSync: vi.fn(),
  spawn: vi.fn()
}))

import { gitExecFileAsync } from '../git-exec-file'
import { GitAdmissionScheduler } from '../../../../shared/git/admission/git-admission-scheduler'
import { _resetGitAdmissionForTests } from '../admission/git-subprocess-admission'

class MockChildProcess extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  kill = vi.fn()
  constructor(readonly pid: number) {
    super()
  }
}
const createMockChildProcess = (pid: number): MockChildProcess => new MockChildProcess(pid)

beforeEach(() => {
  execFileMock.mockReset()
})
afterEach(() => _resetGitAdmissionForTests())

describe('network Git SSH policy', () => {
  it('admits the core.sshCommand probe before spawning it', async () => {
    const scheduler = new GitAdmissionScheduler({ generalCap: 1, generalHeadroom: 0 })
    _resetGitAdmissionForTests(scheduler)
    const blocker = await scheduler.acquire({ args: ['status'], cwd: '/repo', tier: 'status' })
    const calls: string[][] = []
    execFileMock.mockImplementation((_cmd, args, _opts, cb) => {
      const child = createMockChildProcess(1234 + calls.length)
      calls.push(args)
      cb(null, '', '')
      queueMicrotask(() => child.emit('close', 0, null))
      return child
    })

    const pending = gitExecFileAsync(['fetch', '--no-write-fetch-head', 'origin'], {
      cwd: '/repo',
      env: {},
      useConfiguredSshCommandForNetwork: true
    })
    await Promise.resolve()
    expect(execFileMock).not.toHaveBeenCalled()

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
      execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
        cb(error, '', '')
        return createMockChildProcess(1234)
      })
      await expect(gitExecFileAsync(['fetch', 'origin'], { cwd: '/repo', env: {} })).rejects.toBe(
        error
      )
      expect(execFileMock).toHaveBeenCalledTimes(1)
      expect(execFileMock.mock.calls[0]?.[1]?.[0]).toBe('config')
    }
  )
})
