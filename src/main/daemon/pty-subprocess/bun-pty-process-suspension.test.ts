import { constants } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBunPtyProducerFlowControl } from './bun-pty-process-flow-control'

const TABLE = '4321 4321 pts/test T\n4322 4322 pts/test S\n4323 4323 pts/test T'
const settled = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

function harness(platform: NodeJS.Platform = 'linux') {
  let exited = false
  const kill = vi.fn()
  const signalProcessGroup = vi.fn()
  const readProcessTableAsync = vi.fn(async () => TABLE)
  const windowsJob = {
    listProcessIds: () => [],
    pause: vi.fn(() => true),
    resume: vi.fn(() => true),
    terminate: () => 'terminated' as const,
    close() {}
  }
  const flow = createBunPtyProducerFlowControl({
    platform,
    processHandle: { pid: 4321, kill, terminal: { closed: false, close() {} } },
    windowsJob,
    isExited: () => exited,
    readProcessTable: () => TABLE,
    readProcessTableAsync,
    signalProcessGroup
  })
  return {
    flow,
    kill,
    signalProcessGroup,
    readProcessTableAsync,
    windowsJob,
    exit: () => (exited = true)
  }
}

afterEach(() => vi.useRealTimers())

describe('flow-control suspension ownership', () => {
  it.each(['resume', 'shutdown'] as const)(
    'preserves a Ctrl-Z stopped job during %s',
    async (action) => {
      const h = harness()
      h.flow.pause()
      await settled()
      h.readProcessTableAsync.mockResolvedValue(TABLE.replace('4322 pts/test S', '4322 pts/test T'))
      if (action === 'resume') {
        h.flow.resume()
      } else {
        h.flow.resumeForShutdown()
      }
      await settled()
      expect(h.signalProcessGroup.mock.calls).toEqual([
        [4321, 'SIGSTOP'],
        [4322, 'SIGSTOP'],
        [4322, 'SIGCONT'],
        [4321, 'SIGCONT']
      ])
    }
  )

  it('does not resume a group it already released when another group needs a retry', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const h = harness()
    h.readProcessTableAsync.mockResolvedValue(TABLE.replace('4323 pts/test T', '4323 pts/test S'))
    let failed = false
    h.signalProcessGroup.mockImplementation((pgid, signal) => {
      if (pgid === 4323 && signal === 'SIGCONT' && !failed) {
        failed = true
        throw new Error('temporary resume failure')
      }
    })
    h.flow.pause()
    await settled()
    h.flow.resume()
    await settled()
    // The user can suspend a job again after its first successful resume.
    h.readProcessTableAsync.mockResolvedValue(TABLE.replace('4322 pts/test S', '4322 pts/test T'))
    await vi.advanceTimersByTimeAsync(500)
    expect(
      h.signalProcessGroup.mock.calls.filter(
        ([pid, signal]) => pid === 4322 && signal === 'SIGCONT'
      )
    ).toHaveLength(1)
    expect(h.signalProcessGroup).toHaveBeenLastCalledWith(4321, 'SIGCONT')
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['EPERM', 'EACCES'])('does not retry a root pause denied with %s', async (code) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const h = harness()
    h.kill.mockImplementationOnce(() => {
      throw Object.assign(new Error('denied'), { code })
    })
    h.flow.pause()
    await settled()
    h.flow.pause()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(h.kill.mock.calls).toEqual([[constants.signals.SIGSTOP]])
    expect(h.readProcessTableAsync).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    h.flow.resume()
    h.flow.pause()
    await settled()
    expect(h.kill).toHaveBeenCalledTimes(2)
    h.flow.resumeForShutdown()
  })

  it('rolls back acquired stops after a denied job pause without repeatedly scanning or resuming the denied job', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const h = harness()
    h.readProcessTableAsync.mockResolvedValue(`${TABLE}\n4324 4324 pts/test S`)
    h.signalProcessGroup.mockImplementation((pgid, signal) => {
      if (pgid === 4324 && signal === 'SIGSTOP') {
        throw Object.assign(new Error('denied'), { code: 'EPERM' })
      }
    })
    h.flow.pause()
    await settled()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(h.signalProcessGroup.mock.calls).toEqual([
      [4321, 'SIGSTOP'],
      [4322, 'SIGSTOP'],
      [4324, 'SIGSTOP'],
      [4322, 'SIGCONT'],
      [4321, 'SIGCONT']
    ])
    expect(h.readProcessTableAsync).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retains the resume obligation when rollback after a denied pause also fails', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const h = harness()
    let failed = false
    h.signalProcessGroup.mockImplementation((pgid, signal) => {
      if (pgid === 4322 && signal === 'SIGSTOP') {
        throw Object.assign(new Error('denied'), { code: 'EPERM' })
      }
      if (pgid === 4321 && signal === 'SIGCONT' && !failed) {
        failed = true
        throw Object.assign(new Error('resume denied'), { code: 'EPERM' })
      }
    })
    h.flow.pause()
    await settled()
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(500)
    expect(h.signalProcessGroup.mock.calls).toEqual([
      [4321, 'SIGSTOP'],
      [4322, 'SIGSTOP'],
      [4321, 'SIGCONT'],
      [4321, 'SIGCONT']
    ])
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('Windows resume retries', () => {
  it('releases a failed partial pause without repeatedly attempting the denied pause', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const h = harness('win32')
    h.windowsJob.pause.mockReturnValueOnce(false)
    h.windowsJob.resume.mockReturnValueOnce(false)
    h.flow.pause()
    await vi.advanceTimersByTimeAsync(500)
    expect(h.windowsJob.resume).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(500)
    expect(h.windowsJob.resume).toHaveBeenCalledTimes(2)
    expect(h.windowsJob.pause).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    h.flow.pause()
    expect(h.windowsJob.pause).toHaveBeenCalledTimes(2)
    h.flow.resumeForShutdown()
  })

  it('retries a failed resume without another caller transition', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const h = harness('win32')
    h.windowsJob.resume.mockReturnValueOnce(false)
    h.flow.pause()
    h.flow.resume()
    expect(h.windowsJob.resume).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(500)
    expect(h.windowsJob.resume).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
    expect(h.readProcessTableAsync).not.toHaveBeenCalled()
  })

  it.each(['pause', 'shutdown', 'exit'] as const)(
    'cancels stale resume retries after %s',
    async (action) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const h = harness('win32')
      h.windowsJob.resume.mockReturnValue(false)
      h.flow.pause()
      h.flow.resume()
      if (action === 'pause') {
        h.flow.pause()
      } else {
        if (action === 'exit') {
          h.exit()
        }
        h.flow.resumeForShutdown()
      }
      const resumes = h.windowsJob.resume.mock.calls.length
      await vi.advanceTimersByTimeAsync(5_000)
      expect(h.windowsJob.resume).toHaveBeenCalledTimes(resumes)
      expect(vi.getTimerCount()).toBe(0)
    }
  )
})
