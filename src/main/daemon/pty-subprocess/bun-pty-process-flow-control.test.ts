import { describe, expect, it, vi } from 'vitest'
import { createBunPtyProducerFlowControl } from './bun-pty-process-flow-control'

const TABLE = '4321 4321 pts/test\n4322 4322 pts/test'
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

describe('asynchronous POSIX producer flow control', () => {
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
    expect(harness.kill).not.toHaveBeenCalled()

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
    harness.reads[1].resolve('4321 4321 pts/test\n4322 4322 pts/other\n4323 4323 pts/test')
    await settled()

    expect(harness.signalProcessGroup.mock.calls).toEqual([
      [4322, 'SIGSTOP'],
      [4321, 'SIGSTOP'],
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
      [4322, 'SIGSTOP'],
      [4321, 'SIGSTOP']
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
    expect(harness.kill).not.toHaveBeenCalled()
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
      [4322, 'SIGSTOP'],
      [4321, 'SIGSTOP'],
      [4322, 'SIGCONT'],
      [4321, 'SIGCONT']
    ])
    harness.reads[1].resolve(TABLE)
    await settled()
    expect(harness.signalProcessGroup).toHaveBeenCalledTimes(4)
  })

  it('resumes a partially stopped tree and allows a failed resume to be retried', async () => {
    const harness = createHarness()
    const denied = Object.assign(new Error('denied'), { code: 'EPERM' })
    harness.signalProcessGroup.mockImplementationOnce(() => {
      throw denied
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
    harness.flow.resume()
    await settled()
    harness.reads[2].resolve(TABLE)
    await settled()
    expect(harness.signalProcessGroup.mock.calls).toEqual([
      [4322, 'SIGSTOP'],
      [4321, 'SIGSTOP'],
      [4322, 'SIGCONT'],
      [4321, 'SIGCONT'],
      [4322, 'SIGCONT'],
      [4321, 'SIGCONT']
    ])
  })
})
