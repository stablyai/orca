import { describe, expect, it, vi } from 'vitest'
import { WorktreeScanGate } from './worktree-scan-gate'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('WorktreeScanGate', () => {
  it('bounds active operations and starts queued work in FIFO order', async () => {
    const gate = new WorktreeScanGate(2)
    const first = deferred<number>()
    const second = deferred<number>()
    const starts: number[] = []
    const run = (id: number, result: Promise<number>) =>
      gate.run(() => {
        starts.push(id)
        return { result }
      })

    const calls = [run(1, first.promise), run(2, second.promise), run(3, Promise.resolve(3))]
    await vi.waitFor(() => expect(starts).toEqual([1, 2]))
    first.resolve(1)
    await vi.waitFor(() => expect(starts).toEqual([1, 2, 3]))
    second.resolve(2)

    await expect(Promise.all(calls)).resolves.toEqual([1, 2, 3])
  })

  it('removes a queued acquisition when its caller aborts', async () => {
    const gate = new WorktreeScanGate(1)
    const active = deferred<number>()
    const controller = new AbortController()
    const first = gate.run(() => ({ result: active.promise }))
    const queued = gate.run(() => ({ result: Promise.resolve(2) }), { signal: controller.signal })

    controller.abort()
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' })
    active.resolve(1)
    await expect(first).resolves.toBe(1)
  })

  it('does not start after abort wins the acquired-permit microtask handoff', async () => {
    const gate = new WorktreeScanGate(1)
    const settlement = deferred<void>()
    const controller = new AbortController()
    const first = gate.run(() => ({ result: Promise.resolve(1), settled: settlement.promise }))
    const startSecond = vi.fn(() => ({ result: Promise.resolve(2) }))
    const second = gate.run(startSecond, { signal: controller.signal })

    settlement.resolve()
    queueMicrotask(() => controller.abort())

    await expect(second).rejects.toMatchObject({ name: 'AbortError' })
    expect(startSecond).not.toHaveBeenCalled()
    await expect(first).resolves.toBe(1)
  })

  it('retains a permit until resource settlement after the result rejects', async () => {
    const gate = new WorktreeScanGate(1)
    const settled = deferred<void>()
    const starts: number[] = []
    const first = gate.run(() => {
      starts.push(1)
      return { result: Promise.reject(new Error('timed out')), settled: settled.promise }
    })
    const second = gate.run(() => {
      starts.push(2)
      return { result: Promise.resolve(2) }
    })

    await expect(first).rejects.toThrow('timed out')
    expect(starts).toEqual([1])
    settled.resolve()
    await expect(second).resolves.toBe(2)
  })

  it('rejects instead of throwing when start fails on the free-permit path', async () => {
    const gate = new WorktreeScanGate(1)
    const tracked = gate.runTracked<number>(() => {
      throw new Error('spawn failed')
    })

    await expect(tracked.result).rejects.toThrow('spawn failed')
    await expect(tracked.settled).resolves.toBeUndefined()
    // Why: the permit must come back, or one synchronous failure wedges the gate.
    await expect(gate.run(() => ({ result: Promise.resolve(2) }))).resolves.toBe(2)
  })

  it('rejects and releases the permit when start fails on the queued path', async () => {
    const gate = new WorktreeScanGate(1)
    const active = deferred<number>()
    const first = gate.run(() => ({ result: active.promise }))
    const queued = gate.run<number>(() => {
      throw new Error('spawn failed')
    })

    active.resolve(1)
    await expect(first).resolves.toBe(1)
    await expect(queued).rejects.toThrow('spawn failed')
    await expect(gate.run(() => ({ result: Promise.resolve(3) }))).resolves.toBe(3)
  })

  it('reclaims a permit whose resources never report settlement', async () => {
    vi.useFakeTimers()
    try {
      const gate = new WorktreeScanGate(1, { settlementTimeoutMs: 1_000 })
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const first = gate.runTracked(() => ({
        result: Promise.resolve(1),
        // Why: a disposed mux or a wedged process tree leaves settlement pending forever.
        settled: new Promise<void>(() => {})
      }))
      const starts: number[] = []
      const second = gate.run(() => {
        starts.push(2)
        return { result: Promise.resolve(2) }
      })

      await expect(first.result).resolves.toBe(1)
      expect(starts).toEqual([])

      await vi.advanceTimersByTimeAsync(1_000)
      await expect(second).resolves.toBe(2)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('reclaiming a scan permit'))
      warn.mockRestore()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a reserved permit for interactive scans while the sweep saturates the pool', async () => {
    const gate = new WorktreeScanGate(2, { reservedForInteractive: 1 })
    const sweep = deferred<number>()
    const starts: string[] = []
    const background = gate.run(() => {
      starts.push('sweep-1')
      return { result: sweep.promise }
    })
    const queued = gate.run(() => {
      starts.push('sweep-2')
      return { result: Promise.resolve(2) }
    })
    const interactive = gate.run(
      () => {
        starts.push('interactive')
        return { result: Promise.resolve(3) }
      },
      { interactive: true }
    )

    await expect(interactive).resolves.toBe(3)
    expect(starts).toEqual(['sweep-1', 'interactive'])
    sweep.resolve(1)
    await expect(Promise.all([background, queued])).resolves.toEqual([1, 2])
  })

  it('hands the next permit to the host holding the fewest', async () => {
    const gate = new WorktreeScanGate(2)
    const slowHost = [deferred<number>(), deferred<number>()]
    const starts: string[] = []
    const run = (ownerKey: string, id: string, result: Promise<number>) =>
      gate.run(
        () => {
          starts.push(id)
          return { result }
        },
        { ownerKey }
      )

    const held = [
      run('ssh:a', 'a-1', slowHost[0].promise),
      run('ssh:a', 'a-2', slowHost[1].promise)
    ]
    const queuedA = run('ssh:a', 'a-3', Promise.resolve(3))
    const queuedB = run('local', 'b-1', Promise.resolve(4))

    await vi.waitFor(() => expect(starts).toEqual(['a-1', 'a-2']))
    slowHost[0].resolve(1)
    // Why: strict FIFO would let one slow host's backlog starve every other host behind it.
    await expect(queuedB).resolves.toBe(4)
    expect(starts.indexOf('b-1')).toBeLessThan(starts.indexOf('a-3'))
    slowHost[1].resolve(2)
    await expect(Promise.all([...held, queuedA])).resolves.toEqual([1, 2, 3])
  })

  it('exposes result and resource lifetimes to the scan owner', async () => {
    const gate = new WorktreeScanGate(1)
    const settlement = deferred<void>()
    const tracked = gate.runTracked(() => ({
      result: Promise.resolve(1),
      settled: settlement.promise
    }))

    await expect(tracked.result).resolves.toBe(1)
    let settled = false
    void tracked.settled.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    settlement.resolve()
    await expect(tracked.settled).resolves.toBeUndefined()
  })
})
