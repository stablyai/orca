import { constants } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBunPtyProducerFlowControl } from './bun-pty-process-flow-control'

const TABLE = '4321 4321 pts/test T\n4322 4322 pts/test S'
const settled = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

function createHarness() {
  let exited = false
  const kill = vi.fn()
  const signalProcessGroup = vi.fn()
  const readProcessTableAsync = vi.fn<(signal: AbortSignal) => Promise<string>>()
  const flow = createBunPtyProducerFlowControl({
    platform: 'linux',
    processHandle: { pid: 4321, kill, terminal: { closed: false, close() {} } },
    windowsJob: null,
    isExited: () => exited,
    readProcessTableAsync,
    signalProcessGroup
  })
  return { flow, kill, readProcessTableAsync, signalProcessGroup, exit: () => (exited = true) }
}

afterEach(() => vi.useRealTimers())

describe('Bun producer pause retry', () => {
  it('retries a failed root suspension before attempting any group signals', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const harness = createHarness()
    harness.kill.mockImplementationOnce(() => {
      throw new Error('temporary signal rejection')
    })
    harness.readProcessTableAsync.mockResolvedValue(TABLE)
    harness.flow.pause()
    await settled()
    expect(harness.readProcessTableAsync).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(500)
    expect(harness.kill.mock.calls).toEqual([
      [constants.signals.SIGSTOP],
      [constants.signals.SIGSTOP]
    ])
    expect(harness.signalProcessGroup.mock.calls).toEqual([
      [4321, 'SIGSTOP'],
      [4322, 'SIGSTOP']
    ])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps ownership discovery pending when the stopped root has no controlling tty', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const harness = createHarness()
    harness.readProcessTableAsync.mockResolvedValueOnce('4321 4321 ? T').mockResolvedValue(TABLE)
    harness.flow.pause()
    await settled()
    expect(harness.signalProcessGroup).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(500)
    expect(harness.signalProcessGroup.mock.calls).toEqual([
      [4321, 'SIGSTOP'],
      [4322, 'SIGSTOP']
    ])
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['lookup failure', 'shell still running'])(
    'eventually stops jobs after a transient %s without another pause request',
    async (failure) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const harness = createHarness()
      if (failure === 'lookup failure') {
        harness.readProcessTableAsync.mockRejectedValueOnce(new Error('ps timed out'))
      } else {
        harness.readProcessTableAsync.mockResolvedValueOnce(TABLE.replace('test T', 'test S'))
      }
      harness.readProcessTableAsync.mockResolvedValue(TABLE)
      harness.flow.pause()
      await settled()
      expect(harness.kill.mock.calls).toEqual([[constants.signals.SIGSTOP]])
      expect(harness.signalProcessGroup).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(499)
      expect(harness.readProcessTableAsync).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(1)
      expect(harness.signalProcessGroup.mock.calls).toEqual([
        [4321, 'SIGSTOP'],
        [4322, 'SIGSTOP']
      ])
      expect(vi.getTimerCount()).toBe(0)
      harness.flow.resume()
      await settled()
      expect(harness.signalProcessGroup.mock.calls.slice(2)).toEqual([
        [4322, 'SIGCONT'],
        [4321, 'SIGCONT']
      ])
    }
  )

  it.each(['resume', 'shutdown', 'exit'] as const)(
    'bounds failed pause probes and cancels them after %s',
    async (action) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const harness = createHarness()
      harness.readProcessTableAsync.mockRejectedValue(new Error('ps unavailable'))
      harness.flow.pause()
      await settled()
      await vi.advanceTimersByTimeAsync(2_000)
      expect(harness.readProcessTableAsync).toHaveBeenCalledTimes(5)
      expect(vi.getTimerCount()).toBe(1)
      expect(harness.signalProcessGroup).not.toHaveBeenCalled()
      if (action === 'resume') {
        harness.flow.resume()
      } else {
        if (action === 'exit') {
          harness.exit()
        }
        harness.flow.resumeForShutdown()
      }
      await settled()
      const reads = harness.readProcessTableAsync.mock.calls.length
      await vi.advanceTimersByTimeAsync(5_000)
      expect(harness.readProcessTableAsync).toHaveBeenCalledTimes(reads)
      expect(vi.getTimerCount()).toBe(0)
      expect(harness.kill.mock.calls).toEqual(
        action === 'exit'
          ? [[constants.signals.SIGSTOP]]
          : [[constants.signals.SIGSTOP], [constants.signals.SIGCONT]]
      )
    }
  )
})
