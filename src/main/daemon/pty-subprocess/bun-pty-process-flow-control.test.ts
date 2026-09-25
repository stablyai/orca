import { constants } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBunPtyProducerFlowControl } from './bun-pty-process-flow-control'

const TABLE = '4321 4321 pts/test T\n4322 4322 pts/test'
const settled = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

function createHarness() {
  let exited = false
  const reads: { resolve: (table: string) => void; signal: AbortSignal }[] = []
  const readProcessTableAsync = vi.fn(
    (signal: AbortSignal) =>
      new Promise<string>((resolve) => {
        reads.push({ resolve, signal })
      })
  )
  const signalProcessGroup = vi.fn<(pgid: number, signal: NodeJS.Signals) => void>()
  const kill = vi.fn()
  const flow = createBunPtyProducerFlowControl({
    platform: 'linux',
    processHandle: { pid: 4321, kill, terminal: { closed: false, close() {} } },
    windowsJob: null,
    isExited: () => exited,
    readProcessTable: () => TABLE,
    readProcessTableAsync,
    signalProcessGroup
  })
  return {
    flow,
    reads,
    kill,
    readProcessTableAsync,
    signalProcessGroup,
    exit: () => {
      exited = true
    }
  }
}

afterEach(() => vi.useRealTimers())

describe('asynchronous POSIX producer flow control', () => {
  it.each(['S', 'R', ''])(
    'leaves jobs running unless the shell is observed stopped (state %s)',
    async (state) => {
      const harness = createHarness()
      harness.flow.pause()
      expect(harness.kill.mock.calls).toEqual([[constants.signals.SIGSTOP]])
      expect(harness.readProcessTableAsync).not.toHaveBeenCalled()
      await settled()
      harness.reads[0].resolve(TABLE.replace('pts/test T', `pts/test ${state}`))
      await settled()
      expect(harness.signalProcessGroup).not.toHaveBeenCalled()
      harness.flow.resume()
      await settled()
      harness.reads[1].resolve(TABLE)
      await settled()
      expect(harness.kill.mock.calls).toEqual([
        [constants.signals.SIGSTOP],
        [constants.signals.SIGCONT]
      ])
      expect(harness.signalProcessGroup).not.toHaveBeenCalled()
    }
  )

  it('does not attempt a group pause after the owned shell cannot be stopped', async () => {
    const harness = createHarness()
    harness.kill.mockImplementationOnce(() => {
      throw Object.assign(new Error('denied'), { code: 'EPERM' })
    })
    harness.flow.pause()
    await settled()
    harness.flow.resume()
    await settled()
    expect(harness.kill.mock.calls).toEqual([[constants.signals.SIGSTOP]])
    expect(harness.readProcessTableAsync).not.toHaveBeenCalled()
    expect(harness.signalProcessGroup).not.toHaveBeenCalled()
  })

  it('retries a failed resume lookup without another caller resume or stale group signals', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const harness = createHarness()
    harness.flow.pause()
    await settled()
    harness.reads[0].resolve(TABLE)
    await settled()
    harness.readProcessTableAsync.mockRejectedValueOnce(new Error('temporary ps failure'))
    harness.flow.resume()
    await settled()
    expect(harness.signalProcessGroup.mock.calls).toEqual([
      [4321, 'SIGSTOP'],
      [4322, 'SIGSTOP']
    ])
    expect(harness.kill.mock.calls).toEqual([[constants.signals.SIGSTOP]])

    await vi.advanceTimersByTimeAsync(1_000)
    expect(harness.readProcessTableAsync).toHaveBeenCalledTimes(3)
    harness.reads[1].resolve('4321 4321 pts/test T\n4322 4322 pts/other\n4323 4323 pts/test')
    await settled()
    expect(harness.signalProcessGroup.mock.calls.slice(2)).toEqual([
      [4323, 'SIGCONT'],
      [4321, 'SIGCONT']
    ])
    await vi.advanceTimersByTimeAsync(5_000)
    expect(harness.readProcessTableAsync).toHaveBeenCalledTimes(3)
  })

  it.each(['pause', 'shutdown', 'exit'] as const)(
    'cancels a scheduled resume retry after %s',
    async (action) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const harness = createHarness()
      harness.flow.pause()
      await settled()
      harness.reads[0].resolve(TABLE)
      await settled()
      harness.readProcessTableAsync.mockRejectedValueOnce(new Error('temporary ps failure'))
      harness.flow.resume()
      await settled()
      expect(vi.getTimerCount()).toBe(1)
      if (action === 'pause') {
        harness.flow.pause()
        await settled()
        harness.reads[1].resolve(TABLE)
        await settled()
      } else {
        if (action === 'exit') {
          harness.exit()
        }
        harness.flow.resumeForShutdown()
      }
      expect(vi.getTimerCount()).toBe(0)
      const signals = harness.signalProcessGroup.mock.calls.length
      await vi.advanceTimersByTimeAsync(5_000)
      expect(harness.signalProcessGroup).toHaveBeenCalledTimes(signals)
      expect(harness.readProcessTableAsync).toHaveBeenCalledTimes(action === 'pause' ? 3 : 2)
    }
  )

  it('bounds retries while discovery stays unavailable and resumes after it recovers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const harness = createHarness()
    harness.flow.pause()
    await settled()
    harness.reads[0].resolve(TABLE)
    await settled()
    harness.readProcessTableAsync.mockRejectedValue(new Error('ps unavailable'))
    harness.flow.resume()
    await settled()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(harness.readProcessTableAsync).toHaveBeenCalledTimes(6)
    expect(vi.getTimerCount()).toBe(1)
    expect(harness.kill.mock.calls).toEqual([[constants.signals.SIGSTOP]])
    expect(harness.signalProcessGroup).toHaveBeenCalledTimes(2)
    harness.readProcessTableAsync.mockResolvedValue(TABLE)
    await vi.advanceTimersByTimeAsync(500)
    expect(harness.signalProcessGroup).toHaveBeenLastCalledWith(4321, 'SIGCONT')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('resumes a root-only suspension when process group discovery is unavailable throughout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const harness = createHarness()
    harness.readProcessTableAsync.mockRejectedValue(new Error('ps unavailable'))
    harness.flow.pause()
    await settled()
    harness.flow.resume()
    await settled()
    expect(harness.kill.mock.calls).toEqual([
      [constants.signals.SIGSTOP],
      [constants.signals.SIGCONT]
    ])
    expect(harness.signalProcessGroup).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reapplies pause after a partial resume and keeps the shell stopped until all jobs resume', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const harness = createHarness()
    const table = `${TABLE}\n4323 4323 pts/test`
    let denyOnce = true
    harness.signalProcessGroup.mockImplementation((pgid, signal) => {
      if (pgid === 4323 && signal === 'SIGCONT' && denyOnce) {
        denyOnce = false
        throw Object.assign(new Error('denied'), { code: 'EPERM' })
      }
    })
    harness.flow.pause()
    await settled()
    harness.reads[0].resolve(table)
    await settled()
    harness.flow.resume()
    await settled()
    harness.reads[1].resolve(table)
    await settled()
    expect(harness.signalProcessGroup.mock.calls.slice(3)).toEqual([
      [4322, 'SIGCONT'],
      [4323, 'SIGCONT']
    ])
    expect(vi.getTimerCount()).toBe(1)
    harness.flow.pause()
    await settled()
    harness.reads[2].resolve(table)
    await settled()
    expect(harness.signalProcessGroup.mock.calls.slice(5)).toEqual([
      [4321, 'SIGSTOP'],
      [4322, 'SIGSTOP'],
      [4323, 'SIGSTOP']
    ])
    expect(vi.getTimerCount()).toBe(0)
    harness.flow.resume()
    await settled()
    harness.reads[3].resolve(table)
    await settled()
    expect(harness.signalProcessGroup.mock.calls.slice(8)).toEqual([
      [4322, 'SIGCONT'],
      [4323, 'SIGCONT'],
      [4321, 'SIGCONT']
    ])
  })

  it('does not delay the shell resume for a job group that already exited', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const harness = createHarness()
    harness.flow.pause()
    await settled()
    harness.reads[0].resolve(TABLE)
    await settled()
    harness.signalProcessGroup.mockImplementationOnce(() => {
      throw Object.assign(new Error('gone'), { code: 'ESRCH' })
    })
    harness.flow.resume()
    await settled()
    harness.reads[1].resolve(TABLE)
    await settled()
    expect(harness.signalProcessGroup).toHaveBeenLastCalledWith(4321, 'SIGCONT')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('coalesces repeated pressure changes while discovery is pending', async () => {
    const harness = createHarness()
    harness.flow.pause()
    await settled()
    for (let i = 0; i < 1_000; i += 1) {
      harness.flow.resume()
      harness.flow.pause()
    }
    harness.flow.resume()
    await settled()
    expect(harness.readProcessTableAsync).toHaveBeenCalledOnce()
    expect(harness.signalProcessGroup).not.toHaveBeenCalled()

    harness.reads[0].resolve(TABLE)
    await settled()
    expect(harness.signalProcessGroup).not.toHaveBeenCalled()
    expect(harness.kill.mock.calls).toEqual([
      [constants.signals.SIGSTOP],
      [constants.signals.SIGCONT]
    ])

    for (let i = 0; i < 20; i += 1) {
      harness.flow.pause()
      await settled()
      harness.reads[2 * i + 1].resolve(TABLE)
      await settled()
      harness.flow.resume()
      await settled()
      harness.reads[2 * i + 2].resolve(TABLE)
      await settled()
    }
    expect(harness.readProcessTableAsync).toHaveBeenCalledTimes(41)
    expect(harness.signalProcessGroup).toHaveBeenCalledTimes(80)
    expect(harness.signalProcessGroup).toHaveBeenLastCalledWith(4321, 'SIGCONT')
  })

  it('revalidates group ownership when resuming after a process id is reused', async () => {
    const harness = createHarness()
    harness.flow.pause()
    await settled()
    harness.reads[0].resolve(TABLE)
    await settled()
    harness.flow.resume()
    await settled()
    harness.reads[1].resolve('4321 4321 pts/test T\n4322 4322 pts/other\n4323 4323 pts/test')
    await settled()

    expect(harness.signalProcessGroup.mock.calls).toEqual([
      [4321, 'SIGSTOP'],
      [4322, 'SIGSTOP'],
      [4323, 'SIGCONT'],
      [4321, 'SIGCONT']
    ])
  })

  it('does not resume a still-paused session when pressure returns during a resume scan', async () => {
    const harness = createHarness()
    harness.flow.pause()
    await settled()
    harness.reads[0].resolve(TABLE)
    await settled()
    harness.flow.resume()
    await settled()
    harness.flow.pause()
    harness.reads[1].resolve(TABLE)
    await settled()
    expect(harness.signalProcessGroup.mock.calls).toEqual([
      [4321, 'SIGSTOP'],
      [4322, 'SIGSTOP']
    ])

    harness.flow.resume()
    await settled()
    harness.reads[2].resolve(TABLE)
    await settled()
    expect(harness.signalProcessGroup).toHaveBeenLastCalledWith(4321, 'SIGCONT')
  })

  it.each(['shutdown', 'exit'] as const)('ignores a late scan after %s', async (action) => {
    const harness = createHarness()
    harness.flow.pause()
    await settled()
    if (action === 'shutdown') {
      harness.flow.resumeForShutdown()
      expect(harness.reads[0].signal.aborted).toBe(true)
    } else {
      harness.exit()
    }
    harness.reads[0].resolve(TABLE)
    await settled()
    expect(harness.signalProcessGroup).not.toHaveBeenCalled()
    expect(harness.kill.mock.calls).toEqual(
      action === 'shutdown'
        ? [[constants.signals.SIGSTOP], [constants.signals.SIGCONT]]
        : [[constants.signals.SIGSTOP]]
    )
  })

  it('releases stopped groups before shutdown while an asynchronous resume is pending', async () => {
    const harness = createHarness()
    harness.flow.pause()
    await settled()
    harness.reads[0].resolve(TABLE)
    await settled()
    harness.flow.resume()
    await settled()
    harness.flow.resumeForShutdown()
    expect(harness.reads[1].signal.aborted).toBe(true)
    expect(harness.signalProcessGroup.mock.calls).toEqual([
      [4321, 'SIGSTOP'],
      [4322, 'SIGSTOP'],
      [4322, 'SIGCONT'],
      [4321, 'SIGCONT']
    ])
    harness.reads[1].resolve(TABLE)
    await settled()
    expect(harness.signalProcessGroup).toHaveBeenCalledTimes(4)
  })

  it('automatically retries a partially failed resume of a partially stopped tree', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const harness = createHarness()
    const denied = Object.assign(new Error('denied'), { code: 'EPERM' })
    harness.signalProcessGroup.mockImplementation((pgid, signal) => {
      if (pgid === 4322 && signal === 'SIGSTOP') {
        throw denied
      }
    })
    harness.flow.pause()
    await settled()
    harness.reads[0].resolve(TABLE)
    await settled()
    harness.signalProcessGroup.mockImplementationOnce(() => {
      throw denied
    })
    harness.flow.resume()
    await settled()
    harness.reads[1].resolve(TABLE)
    await settled()
    await vi.advanceTimersByTimeAsync(500)
    harness.reads[2].resolve(TABLE)
    await settled()
    expect(harness.signalProcessGroup.mock.calls).toEqual([
      [4321, 'SIGSTOP'],
      [4322, 'SIGSTOP'],
      [4322, 'SIGCONT'],
      [4322, 'SIGCONT'],
      [4321, 'SIGCONT']
    ])
  })
})
