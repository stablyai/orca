import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import {
  resetWslTranscriptFsGateForTests,
  runWslTranscriptFsTask,
  WSL_TRANSCRIPT_FS_EXACT_TIMEOUT_MS,
  WSL_TRANSCRIPT_FS_MAX_PENDING_TASKS,
  WSL_TRANSCRIPT_FS_MAX_WAITERS_PER_TASK,
  WSL_TRANSCRIPT_FS_ROUTE_QUARANTINE_BASE_MS,
  WSL_TRANSCRIPT_FS_SCAN_TIMEOUT_MS,
  WslTranscriptFsError
} from './wsl-transcript-fs-gate'

const SLOW_MESSAGE =
  'WSL transcript files are temporarily unavailable because filesystem access is taking too long. Try again shortly or restart Orca if the issue continues.'
const CAPACITY_MESSAGE =
  'WSL transcript discovery is temporarily unavailable because too many filesystem requests are already waiting. Try again shortly or restart Orca if the issue continues.'

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  return {
    promise: new Promise<T>((res, rej) => ((resolve = res), (reject = rej))),
    resolve,
    reject
  }
}

function run(
  path: string,
  priority: 'exact' | 'scan',
  task: () => Promise<string>,
  signal?: AbortSignal
): Promise<string> {
  return runWslTranscriptFsTask(
    { operation: priority === 'exact' ? 'access' : 'readdir', path, priority, signal },
    task
  )
}

describe('WSL transcript filesystem task scheduling', () => {
  let warnSpy: MockInstance

  beforeEach(() => {
    resetWslTranscriptFsGateForTests()
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('does not block an exact probe behind a running scan on the same route', async () => {
    const stalled = deferred<string>()
    const scanTask = vi.fn(() => stalled.promise)
    const scan = run('\\\\wsl.localhost\\Ubuntu\\tree', 'scan', scanTask)
    await vi.waitFor(() => expect(scanTask).toHaveBeenCalledOnce())

    await expect(
      run('\\\\wsl.localhost\\Ubuntu\\transcript.jsonl', 'exact', async () => 'exact')
    ).resolves.toBe('exact')
    stalled.resolve('scan')
    await expect(scan).resolves.toBe('scan')
  })

  it('allows healthy distros and provider routes to bypass a stalled lane', async () => {
    const stalled = deferred<string>()
    const ubuntuLocalhost = run('\\\\wsl.localhost\\Ubuntu\\home\\a', 'scan', () => stalled.promise)
    const debian = vi.fn(async () => 'debian')
    const ubuntuLegacy = vi.fn(async () => 'legacy')

    await expect(run('\\\\wsl.localhost\\Debian\\home\\a', 'exact', debian)).resolves.toBe('debian')
    await expect(run('\\\\wsl$\\Ubuntu\\home\\a', 'exact', ubuntuLegacy)).resolves.toBe('legacy')
    expect(debian).toHaveBeenCalledOnce()
    expect(ubuntuLegacy).toHaveBeenCalledOnce()

    stalled.resolve('localhost')
    await expect(ubuntuLocalhost).resolves.toBe('localhost')
  })

  it('runs an exact probe before older queued scan work', async () => {
    const ubuntu = deferred<string>()
    const debian = deferred<string>()
    const occupied: string[] = []
    const started: string[] = []
    const first = run('\\\\wsl.localhost\\Ubuntu\\a', 'exact', () => {
      occupied.push('ubuntu')
      return ubuntu.promise
    })
    const second = run('\\\\wsl.localhost\\Debian\\a', 'exact', () => {
      occupied.push('debian')
      return debian.promise
    })
    await vi.waitFor(() => expect(occupied).toEqual(['ubuntu', 'debian']))

    const scan = run('\\\\wsl.localhost\\Fedora\\tree', 'scan', async () => {
      started.push('scan')
      return 'scan'
    })
    const exact = run('\\\\wsl.localhost\\Fedora\\file', 'exact', async () => {
      started.push('exact')
      return 'exact'
    })

    debian.resolve('debian')
    await expect(exact).resolves.toBe('exact')
    expect(started).toEqual(['exact', 'scan'])
    await expect(scan).resolves.toBe('scan')
    ubuntu.resolve('ubuntu')
    await expect(Promise.all([first, second])).resolves.toEqual(['ubuntu', 'debian'])
  })

  it('drops abandoned queued work before it reaches the filesystem', async () => {
    const ubuntu = deferred<string>()
    const debian = deferred<string>()
    const first = run('\\\\wsl.localhost\\Ubuntu\\a', 'scan', () => ubuntu.promise)
    const second = run('\\\\wsl.localhost\\Debian\\a', 'scan', () => debian.promise)
    const controller = new AbortController()
    const abandonedTask = vi.fn(async () => 'unused')
    const abandoned = run('\\\\wsl.localhost\\Fedora\\a', 'scan', abandonedTask, controller.signal)

    const reason = new Error('closed subscription')
    controller.abort(reason)
    await expect(abandoned).rejects.toBe(reason)
    ubuntu.resolve('ubuntu')
    debian.resolve('debian')
    await Promise.all([first, second])
    expect(abandonedTask).not.toHaveBeenCalled()
  })

  it('shares only byte-identical requests', async () => {
    const firstTask = vi.fn(async () => 'first')
    const duplicateTask = vi.fn(async () => 'duplicate')
    const first = run('\\\\wsl.localhost\\Ubuntu\\home\\a', 'exact', firstTask)
    const duplicate = run('\\\\wsl.localhost\\Ubuntu\\home\\a', 'exact', duplicateTask)

    await expect(Promise.all([first, duplicate])).resolves.toEqual(['first', 'first'])
    expect(firstTask).toHaveBeenCalledOnce()
    expect(duplicateTask).not.toHaveBeenCalled()
  })

  it('never joins an exact probe onto the same file queued as scan work', async () => {
    const transcript = '\\\\wsl.localhost\\Ubuntu\\home\\ada\\live.jsonl'
    const statTask = (priority: 'exact' | 'scan', task: () => Promise<string>): Promise<string> =>
      runWslTranscriptFsTask({ operation: 'stat', path: transcript, priority }, task)
    // Hold the single scan slot on another distro so the same-file scan stat
    // cannot run — a joiner would inherit exactly that queued position.
    const blocked = deferred<string>()
    const holderTask = vi.fn(() => blocked.promise)
    const holder = run('\\\\wsl.localhost\\Debian\\tree', 'scan', holderTask)
    await vi.waitFor(() => expect(holderTask).toHaveBeenCalledOnce())

    const scanTask = vi.fn(async () => 'scan')
    const scanned = statTask('scan', scanTask)
    const exactTask = vi.fn(async () => 'exact')

    await expect(statTask('exact', exactTask)).resolves.toBe('exact')
    expect(exactTask).toHaveBeenCalledOnce()
    expect(scanTask).not.toHaveBeenCalled()

    blocked.resolve('holder')
    await expect(Promise.all([holder, scanned])).resolves.toEqual(['holder', 'scan'])
  })

  it('keeps shared work needed by a remaining waiter', async () => {
    const pending = deferred<string>()
    const task = vi.fn(() => pending.promise)
    const firstController = new AbortController()
    const secondController = new AbortController()
    const first = run('\\\\wsl.localhost\\Ubuntu\\shared', 'exact', task, firstController.signal)
    const second = run('\\\\wsl.localhost\\Ubuntu\\shared', 'exact', task, secondController.signal)
    await vi.waitFor(() => expect(task).toHaveBeenCalledOnce())

    const reason = new Error('first closed')
    firstController.abort(reason)
    await expect(first).rejects.toBe(reason)
    pending.resolve('second')
    await expect(second).resolves.toBe('second')
    expect(task).toHaveBeenCalledOnce()
  })

  it('does not attach new callers to abandoned running work', async () => {
    const stalled = deferred<string>()
    const firstTask = vi.fn(() => stalled.promise)
    const firstController = new AbortController()
    const first = run(
      '\\\\wsl.localhost\\Ubuntu\\abandoned',
      'exact',
      firstTask,
      firstController.signal
    )
    await vi.waitFor(() => expect(firstTask).toHaveBeenCalledOnce())

    firstController.abort(new Error('first closed'))
    await expect(first).rejects.toThrow('first closed')
    const replacementWork = deferred<string>()
    const replacementTask = vi.fn(() => replacementWork.promise)
    const replacement = run('\\\\wsl.localhost\\Ubuntu\\abandoned', 'exact', replacementTask)

    stalled.resolve('abandoned')
    await vi.waitFor(() => expect(replacementTask).toHaveBeenCalledOnce())
    const duplicateTask = vi.fn(async () => 'duplicate')
    const duplicate = run('\\\\wsl.localhost\\Ubuntu\\abandoned', 'exact', duplicateTask)
    replacementWork.resolve('replacement')

    await expect(Promise.all([replacement, duplicate])).resolves.toEqual([
      'replacement',
      'replacement'
    ])
    expect(replacementTask).toHaveBeenCalledOnce()
    expect(duplicateTask).not.toHaveBeenCalled()
  })

  it('does not conflate provider aliases or Linux path case', async () => {
    const paths = [
      '\\\\wsl.localhost\\Ubuntu\\home\\a',
      '\\\\wsl$\\Ubuntu\\home\\a',
      '\\\\wsl.localhost\\Ubuntu\\mnt\\C\\a',
      '\\\\wsl.localhost\\Ubuntu\\mnt\\c\\a'
    ]
    const tasks = paths.map((path, index) => run(path, 'exact', async () => String(index)))

    await expect(Promise.all(tasks)).resolves.toEqual(['0', '1', '2', '3'])
  })

  it.each([
    ['exact', WSL_TRANSCRIPT_FS_EXACT_TIMEOUT_MS],
    ['scan', WSL_TRANSCRIPT_FS_SCAN_TIMEOUT_MS]
  ] as const)('rejects a stalled %s waiter at its deadline', async (priority, deadlineMs) => {
    vi.useFakeTimers()
    const stalled = deferred<string>()
    try {
      const task = vi.fn(() => stalled.promise)
      const pending = run(`\\\\wsl.localhost\\Deadline-${priority}\\a`, priority, task)
      const rejected = expect(pending).rejects.toMatchObject({
        name: 'WslTranscriptFsError',
        code: 'timeout',
        message: SLOW_MESSAGE
      })
      let settled = false
      void pending.then(
        () => (settled = true),
        () => (settled = true)
      )

      await vi.advanceTimersByTimeAsync(0)
      expect(task).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(deadlineMs - 1)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await rejected
    } finally {
      stalled.resolve('late')
      await vi.advanceTimersByTimeAsync(0)
      vi.useRealTimers()
    }
  })

  it.each([
    ['exact', WSL_TRANSCRIPT_FS_EXACT_TIMEOUT_MS],
    ['scan', WSL_TRANSCRIPT_FS_SCAN_TIMEOUT_MS]
  ] as const)('completes healthy %s work below its deadline', async (priority, deadlineMs) => {
    vi.useFakeTimers()
    const work = deferred<string>()
    try {
      const pending = run(`\\\\wsl.localhost\\Healthy-${priority}\\a`, priority, () => work.promise)

      await vi.advanceTimersByTimeAsync(deadlineMs - 1)
      work.resolve('healthy')
      await expect(pending).resolves.toBe('healthy')
      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(deadlineMs)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      work.resolve('healthy')
      await vi.advanceTimersByTimeAsync(0)
      vi.useRealTimers()
    }
  })

  it('expires every waiter when shared work reaches its enforced deadline', async () => {
    vi.useFakeTimers()
    const work = deferred<string>()
    const task = vi.fn(() => work.promise)
    try {
      const path = '\\\\wsl.localhost\\Ubuntu\\staggered'
      const first = run(path, 'exact', task)
      const firstRejected = expect(first).rejects.toMatchObject({ code: 'timeout' })
      await vi.advanceTimersByTimeAsync(10_000)
      const second = run(path, 'exact', task)
      const secondRejected = expect(second).rejects.toMatchObject({ code: 'timeout' })

      await vi.advanceTimersByTimeAsync(WSL_TRANSCRIPT_FS_EXACT_TIMEOUT_MS - 10_000)
      await Promise.all([firstRejected, secondRejected])
      work.resolve('shared')
      expect(task).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      work.resolve('shared')
      await vi.advanceTimersByTimeAsync(0)
      vi.useRealTimers()
    }
  })

  it('rejects newest work when the pending queue is full', async () => {
    vi.useFakeTimers()
    const ubuntu = deferred<string>()
    const debian = deferred<string>()
    const queuedController = new AbortController()
    try {
      const ubuntuTask = vi.fn(() => ubuntu.promise)
      const debianTask = vi.fn(() => debian.promise)
      const first = run('\\\\wsl.localhost\\Ubuntu\\occupied', 'exact', ubuntuTask)
      const second = run('\\\\wsl.localhost\\Debian\\occupied', 'exact', debianTask)
      await vi.advanceTimersByTimeAsync(0)

      const queued = Array.from({ length: WSL_TRANSCRIPT_FS_MAX_PENDING_TASKS }, (_, index) =>
        run(
          `\\\\wsl.localhost\\Queued-${index}\\a`,
          'exact',
          async () => String(index),
          index === 0 ? queuedController.signal : undefined
        )
      )
      const overflowTask = vi.fn(async () => 'overflow')
      await expect(
        run('\\\\wsl.localhost\\Overflow\\a', 'exact', overflowTask)
      ).rejects.toMatchObject({ code: 'capacity', message: CAPACITY_MESSAGE })
      expect(overflowTask).not.toHaveBeenCalled()

      const reason = new Error('queued caller closed')
      queuedController.abort(reason)
      await expect(queued[0]).rejects.toBe(reason)
      const replacement = run('\\\\wsl.localhost\\Replacement\\a', 'exact', async () => 'new')

      ubuntu.resolve('ubuntu')
      debian.resolve('debian')
      await expect(
        Promise.all([first, second, ...queued.slice(1), replacement])
      ).resolves.toHaveLength(WSL_TRANSCRIPT_FS_MAX_PENDING_TASKS + 2)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      ubuntu.resolve('ubuntu')
      debian.resolve('debian')
      await vi.advanceTimersByTimeAsync(0)
      vi.useRealTimers()
    }
  })

  it('caps callers waiting on shared work', async () => {
    vi.useFakeTimers()
    const stalled = deferred<string>()
    const task = vi.fn(() => stalled.promise)
    const firstController = new AbortController()
    try {
      const path = '\\\\wsl.localhost\\Ubuntu\\shared-cap'
      const waiters = Array.from({ length: WSL_TRANSCRIPT_FS_MAX_WAITERS_PER_TASK }, (_, index) =>
        run(path, 'exact', task, index === 0 ? firstController.signal : undefined)
      )
      await vi.advanceTimersByTimeAsync(0)

      await expect(run(path, 'exact', task)).rejects.toMatchObject({
        code: 'capacity',
        message: CAPACITY_MESSAGE
      })
      const reason = new Error('first waiter closed')
      firstController.abort(reason)
      await expect(waiters[0]).rejects.toBe(reason)
      const replacement = run(path, 'exact', task)
      stalled.resolve('shared')
      await expect(Promise.all([...waiters.slice(1), replacement])).resolves.toEqual(
        Array(WSL_TRANSCRIPT_FS_MAX_WAITERS_PER_TASK).fill('shared')
      )
      expect(task).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      stalled.resolve('shared')
      await vi.advanceTimersByTimeAsync(0)
      vi.useRealTimers()
    }
  })

  it('restores both permits after running work exceeds its deadline', async () => {
    vi.useFakeTimers()
    const ubuntu = deferred<string>()
    const debian = deferred<string>()
    try {
      const first = run('\\\\wsl.localhost\\Ubuntu\\stalled', 'exact', () => ubuntu.promise)
      const second = run('\\\\wsl.localhost\\Debian\\stalled', 'exact', () => debian.promise)
      const firstRejected = expect(first).rejects.toBeInstanceOf(WslTranscriptFsError)
      const secondRejected = expect(second).rejects.toBeInstanceOf(WslTranscriptFsError)

      await vi.advanceTimersByTimeAsync(WSL_TRANSCRIPT_FS_EXACT_TIMEOUT_MS)
      await Promise.all([firstRejected, secondRejected])
      const laterTask = vi.fn(async () => 'later')
      await expect(run('\\\\wsl.localhost\\Fedora\\later', 'exact', laterTask)).resolves.toBe(
        'later'
      )
      expect(laterTask).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      ubuntu.resolve('ubuntu')
      debian.resolve('debian')
      await vi.advanceTimersByTimeAsync(0)
      vi.useRealTimers()
    }
  })

  // Why: production tasks reject promptly on abort (the isolated process is
  // killed). The sole waiter's timeout must not pre-empt the deadline timer —
  // that would settle the task first and skip the route quarantine entirely.
  it('quarantines the route when a sole-waiter abort-responsive task hits the deadline', async () => {
    vi.useFakeTimers()
    try {
      const path = '\\\\wsl.localhost\\Ubuntu\\solo-stall'
      const stalled = runWslTranscriptFsTask(
        { operation: 'open', path, priority: 'exact', dedupe: false },
        (signal) =>
          new Promise<string>((_resolve, reject) =>
            signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          )
      )
      const stalledRejected = expect(stalled).rejects.toMatchObject({ code: 'timeout' })
      await vi.advanceTimersByTimeAsync(WSL_TRANSCRIPT_FS_EXACT_TIMEOUT_MS)
      await stalledRejected
      const retryTask = vi.fn(async () => 'retry')
      await expect(run(path, 'exact', retryTask)).rejects.toMatchObject({ code: 'unavailable' })
      expect(retryTask).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('lifts a first-strike quarantine quickly and escalates on repeat stalls', async () => {
    // performance.now drives the quarantine clock, so it must be faked too.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
    const path = '\\\\wsl.localhost\\Ubuntu\\cold-start'
    const stallOnce = (): Promise<string> =>
      runWslTranscriptFsTask(
        { operation: 'open', path, priority: 'exact', dedupe: false },
        (signal) =>
          new Promise<string>((_resolve, reject) =>
            signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          )
      )
    try {
      const first = stallOnce()
      const firstRejected = expect(first).rejects.toMatchObject({ code: 'timeout' })
      await vi.advanceTimersByTimeAsync(WSL_TRANSCRIPT_FS_EXACT_TIMEOUT_MS)
      await firstRejected
      await expect(run(path, 'exact', async () => 'early')).rejects.toMatchObject({
        code: 'unavailable'
      })

      // A cold-booted distro recovers here: admitted again after the base window.
      await vi.advanceTimersByTimeAsync(WSL_TRANSCRIPT_FS_ROUTE_QUARANTINE_BASE_MS)
      const second = stallOnce()
      const secondRejected = expect(second).rejects.toMatchObject({ code: 'timeout' })
      await vi.advanceTimersByTimeAsync(WSL_TRANSCRIPT_FS_EXACT_TIMEOUT_MS)
      await secondRejected

      // Second strike doubles the back-off: still blocked after one base window.
      await vi.advanceTimersByTimeAsync(WSL_TRANSCRIPT_FS_ROUTE_QUARANTINE_BASE_MS)
      await expect(run(path, 'exact', async () => 'still-blocked')).rejects.toMatchObject({
        code: 'unavailable'
      })
      await vi.advanceTimersByTimeAsync(WSL_TRANSCRIPT_FS_ROUTE_QUARANTINE_BASE_MS)
      await expect(run(path, 'exact', async () => 'recovered')).resolves.toBe('recovered')

      // The success reset the strikes: the next stall quarantines for the base
      // window again instead of continuing the escalation.
      const third = stallOnce()
      const thirdRejected = expect(third).rejects.toMatchObject({ code: 'timeout' })
      await vi.advanceTimersByTimeAsync(WSL_TRANSCRIPT_FS_EXACT_TIMEOUT_MS)
      await thirdRejected
      await vi.advanceTimersByTimeAsync(WSL_TRANSCRIPT_FS_ROUTE_QUARANTINE_BASE_MS)
      await expect(run(path, 'exact', async () => 'reset')).resolves.toBe('reset')
    } finally {
      vi.useRealTimers()
    }
  })

  // Why: a helper transport fault (child died, fork failed) consulted nothing
  // about the mount, so it must not erase a live quarantine or its strikes.
  it('keeps the quarantine when a same-route transport fault settles', async () => {
    vi.useFakeTimers()
    const stalledExact = deferred<string>()
    const scanWork = deferred<string>()
    try {
      const stalled = run('\\\\wsl.localhost\\Ubuntu\\quarantine-me', 'exact', () => {
        return stalledExact.promise
      })
      const stalledRejected = expect(stalled).rejects.toMatchObject({ code: 'timeout' })
      const scan = run('\\\\wsl.localhost\\Ubuntu\\scan-tree', 'scan', () => scanWork.promise)
      const scanRejected = expect(scan).rejects.toMatchObject({ code: 'unavailable' })

      await vi.advanceTimersByTimeAsync(WSL_TRANSCRIPT_FS_EXACT_TIMEOUT_MS)
      await stalledRejected

      // The still-running scan's helper dies: a transport fault, not an answer.
      scanWork.reject(new WslTranscriptFsError('unavailable', 'helper process died'))
      await vi.advanceTimersByTimeAsync(0)
      await scanRejected

      const retryTask = vi.fn(async () => 'retry')
      await expect(
        run('\\\\wsl.localhost\\Ubuntu\\retry', 'exact', retryTask)
      ).rejects.toMatchObject({ code: 'unavailable' })
      expect(retryTask).not.toHaveBeenCalled()
    } finally {
      stalledExact.resolve('late')
      await vi.advanceTimersByTimeAsync(0)
      vi.useRealTimers()
    }
  })

  it('lets abandoned running work finish instead of aborting its process', async () => {
    const work = deferred<string>()
    const controller = new AbortController()
    const sawAbort = vi.fn()
    const task = vi.fn((signal: AbortSignal) => {
      signal.addEventListener('abort', sawAbort, { once: true })
      return work.promise
    })
    const pending = runWslTranscriptFsTask(
      {
        operation: 'read',
        path: '\\\\wsl.localhost\\Ubuntu\\abandoned-read',
        priority: 'exact',
        dedupe: false,
        signal: controller.signal
      },
      task
    )
    await vi.waitFor(() => expect(task).toHaveBeenCalledOnce())
    const reason = new Error('caller moved on')
    controller.abort(reason)
    await expect(pending).rejects.toBe(reason)
    // A healthy in-flight process op keeps running; only the deadline kills.
    expect(sawAbort).not.toHaveBeenCalled()
    work.resolve('late')
    await Promise.resolve()
  })

  it('quarantines an expired route while keeping healthy routes usable', async () => {
    vi.useFakeTimers()
    const stalled = deferred<string>()
    try {
      const stuck = run('\\\\wsl.localhost\\Ubuntu\\lane-stuck', 'exact', () => stalled.promise)
      const stuckRejected = expect(stuck).rejects.toMatchObject({ code: 'timeout' })
      await vi.advanceTimersByTimeAsync(WSL_TRANSCRIPT_FS_EXACT_TIMEOUT_MS)
      await stuckRejected

      const sameLaneTask = vi.fn(async () => 'same-lane')
      await expect(
        run('\\\\wsl.localhost\\Ubuntu\\lane-stuck-sibling', 'exact', sameLaneTask)
      ).rejects.toMatchObject({ code: 'unavailable' })
      expect(sameLaneTask).not.toHaveBeenCalled()
      await expect(
        run('\\\\wsl.localhost\\Debian\\healthy-lane', 'exact', async () => 'debian')
      ).resolves.toBe('debian')
    } finally {
      stalled.resolve('late')
      await vi.advanceTimersByTimeAsync(0)
      vi.useRealTimers()
    }
  })

  it('restores the scan slot while quarantining the expired route', async () => {
    vi.useFakeTimers()
    const stalled = deferred<string>()
    try {
      const stuckScan = run('\\\\wsl.localhost\\Ubuntu\\stuck-tree', 'scan', () => stalled.promise)
      const stuckRejected = expect(stuckScan).rejects.toMatchObject({ code: 'timeout' })
      await vi.advanceTimersByTimeAsync(WSL_TRANSCRIPT_FS_SCAN_TIMEOUT_MS)
      await stuckRejected

      const otherScanTask = vi.fn(async () => 'other-scan')
      await expect(
        run('\\\\wsl.localhost\\Debian\\other-tree', 'scan', otherScanTask)
      ).resolves.toBe('other-scan')
      expect(otherScanTask).toHaveBeenCalledOnce()
      await expect(
        run('\\\\wsl.localhost\\Ubuntu\\live-probe', 'exact', async () => 'exact')
      ).rejects.toMatchObject({ code: 'unavailable' })
      await expect(
        run('\\\\wsl.localhost\\Debian\\live-probe', 'exact', async () => 'exact')
      ).resolves.toBe('exact')
    } finally {
      stalled.resolve('late')
      await vi.advanceTimersByTimeAsync(0)
      vi.useRealTimers()
    }
  })

  it('does not spend a replacement process on a quarantined route', async () => {
    vi.useFakeTimers()
    const stalled = deferred<string>()
    try {
      const stuck = run('\\\\wsl.localhost\\Ubuntu\\hung-file', 'exact', () => stalled.promise)
      const stuckRejected = expect(stuck).rejects.toMatchObject({ code: 'timeout' })
      await vi.advanceTimersByTimeAsync(WSL_TRANSCRIPT_FS_EXACT_TIMEOUT_MS)
      await stuckRejected

      const doomedScanTask = vi.fn(async () => 'doomed')
      await expect(
        run('\\\\wsl.localhost\\Ubuntu\\tree', 'scan', doomedScanTask)
      ).rejects.toMatchObject({ code: 'unavailable' })
      expect(doomedScanTask).not.toHaveBeenCalled()
      await expect(
        run('\\\\wsl.localhost\\Debian\\tree', 'scan', async () => 'debian-scan')
      ).resolves.toBe('debian-scan')
    } finally {
      stalled.resolve('late')
      await vi.advanceTimersByTimeAsync(0)
      vi.useRealTimers()
    }
  })

  it('ignores a late result after admitting replacement work', async () => {
    // performance.now drives the quarantine clock, so it must be faked too.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
    const stalled = deferred<string>()
    try {
      const stuck = run('\\\\wsl.localhost\\Ubuntu\\recovering', 'exact', () => stalled.promise)
      const stuckRejected = expect(stuck).rejects.toMatchObject({ code: 'timeout' })
      await vi.advanceTimersByTimeAsync(WSL_TRANSCRIPT_FS_EXACT_TIMEOUT_MS)
      await stuckRejected
      await expect(
        run('\\\\wsl.localhost\\Ubuntu\\recovering-next', 'exact', async () => 'blocked')
      ).rejects.toMatchObject({ code: 'unavailable' })

      // A value that only lands past the deadline is the stall itself, not
      // proof of health: it must not cut the back-off short.
      stalled.resolve('late')
      await vi.advanceTimersByTimeAsync(0)
      await expect(
        run('\\\\wsl.localhost\\Ubuntu\\recovering-next', 'exact', async () => 'still-blocked')
      ).rejects.toMatchObject({ code: 'unavailable' })

      await vi.advanceTimersByTimeAsync(WSL_TRANSCRIPT_FS_ROUTE_QUARANTINE_BASE_MS)
      await expect(
        run('\\\\wsl.localhost\\Ubuntu\\recovering-next', 'exact', async () => 'recovered')
      ).resolves.toBe('recovered')
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      stalled.resolve('late')
      await vi.advanceTimersByTimeAsync(0)
      vi.useRealTimers()
    }
  })

  it('starts a new generation after shared work reaches its deadline', async () => {
    // performance.now drives the quarantine clock, so it must be faked too.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
    const work = deferred<string>()
    const task = vi.fn(() => work.promise)
    try {
      const path = '\\\\wsl.localhost\\Ubuntu\\join-stuck'
      const first = run(path, 'exact', task)
      const firstRejected = expect(first).rejects.toMatchObject({ code: 'timeout' })
      await vi.advanceTimersByTimeAsync(10_000)
      const second = run(path, 'exact', task)
      const secondRejected = expect(second).rejects.toMatchObject({ code: 'timeout' })

      await vi.advanceTimersByTimeAsync(WSL_TRANSCRIPT_FS_EXACT_TIMEOUT_MS - 10_000)
      await Promise.all([firstRejected, secondRejected])
      work.resolve('late')
      // The late value settles nothing, so the deadline's back-off still runs.
      await vi.advanceTimersByTimeAsync(WSL_TRANSCRIPT_FS_ROUTE_QUARANTINE_BASE_MS)
      const joinTask = vi.fn(async () => 'join')
      await expect(run(path, 'exact', joinTask)).resolves.toBe('join')
      expect(joinTask).toHaveBeenCalledOnce()
    } finally {
      work.resolve('late')
      await vi.advanceTimersByTimeAsync(0)
      vi.useRealTimers()
    }
  })

  it('fails queued same-route work fast when the deadline quarantines it', async () => {
    vi.useFakeTimers()
    const stalled = deferred<string>()
    const queuedTask = vi.fn(async () => 'queued')
    try {
      const stuck = run('\\\\wsl.localhost\\Ubuntu\\trap-hung', 'exact', () => stalled.promise)
      const stuckRejected = expect(stuck).rejects.toMatchObject({ code: 'timeout' })
      await vi.advanceTimersByTimeAsync(5_000)
      // Queued behind the same route before the hang is detected. Left queued
      // it would strand a full waiter deadline; a sequential multi-file scan
      // would then pay one deadline per file.
      const queuedPath = '\\\\wsl.localhost\\Ubuntu\\trap-queued'
      const queued = run(queuedPath, 'exact', queuedTask)
      const queuedRejected = expect(queued).rejects.toMatchObject({ code: 'unavailable' })

      await vi.advanceTimersByTimeAsync(WSL_TRANSCRIPT_FS_EXACT_TIMEOUT_MS - 5_000)
      await stuckRejected
      await queuedRejected
      expect(queuedTask).not.toHaveBeenCalled()
    } finally {
      stalled.resolve('late')
      await vi.advanceTimersByTimeAsync(0)
      vi.useRealTimers()
    }
  })

  it('keeps exact work moving while an isolated scan process is stalled', async () => {
    vi.useFakeTimers()
    const scanWork = deferred<string>()
    const debianWork = deferred<string>()
    const ubuntuTask = vi.fn(async () => 'ubuntu')
    try {
      const scanU = run(
        '\\\\wsl.localhost\\Ubuntu\\queued-route-tree',
        'scan',
        () => scanWork.promise
      )
      const exactD = run(
        '\\\\wsl.localhost\\Debian\\queued-route-d',
        'exact',
        () => debianWork.promise
      )
      const scanRejected = expect(scanU).rejects.toMatchObject({ code: 'timeout' })
      const exactDRejected = expect(exactD).rejects.toMatchObject({ code: 'timeout' })
      await vi.advanceTimersByTimeAsync(35_000)
      await exactDRejected

      // Queued before Ubuntu's hang is detected at the 60s scan deadline.
      const queuedU = run('\\\\wsl.localhost\\Ubuntu\\queued-route-file', 'exact', ubuntuTask)
      await expect(queuedU).resolves.toBe('ubuntu')
      await vi.advanceTimersByTimeAsync(25_000)
      await scanRejected

      debianWork.resolve('debian')
      await vi.advanceTimersByTimeAsync(0)
      expect(ubuntuTask).toHaveBeenCalledOnce()
    } finally {
      scanWork.resolve('late')
      debianWork.resolve('debian')
      await vi.advanceTimersByTimeAsync(0)
      vi.useRealTimers()
    }
  })

  it('warns once per task that outlives its deadline while running', async () => {
    vi.useFakeTimers()
    const stalled = deferred<string>()
    try {
      const stuck = run('\\\\wsl.localhost\\Ubuntu\\logged', 'exact', () => stalled.promise)
      const stuckRejected = expect(stuck).rejects.toMatchObject({ code: 'timeout' })
      await vi.advanceTimersByTimeAsync(WSL_TRANSCRIPT_FS_EXACT_TIMEOUT_MS * 3)
      await stuckRejected
      expect(warnSpy).toHaveBeenCalledOnce()
      expect(warnSpy.mock.calls[0][0]).toContain('exact')
      expect(warnSpy.mock.calls[0][0]).toContain('logged')
    } finally {
      stalled.resolve('late')
      await vi.advanceTimersByTimeAsync(0)
      vi.useRealTimers()
    }
  })

  it('does not mark a scan permit stuck before the scan deadline', async () => {
    vi.useFakeTimers()
    const exactWork = deferred<string>()
    const scanWork = deferred<string>()
    try {
      const exact = run(
        '\\\\wsl.localhost\\Ubuntu\\stalled-exact',
        'exact',
        () => exactWork.promise
      )
      const scanTask = vi.fn(() => scanWork.promise)
      const scanPath = '\\\\wsl.localhost\\Debian\\healthy-scan'
      const scan = run(scanPath, 'scan', scanTask)
      const exactRejected = expect(exact).rejects.toMatchObject({ code: 'timeout' })

      await vi.advanceTimersByTimeAsync(WSL_TRANSCRIPT_FS_EXACT_TIMEOUT_MS)
      await exactRejected
      const duplicateTask = vi.fn(async () => 'duplicate')
      const duplicate = run(scanPath, 'scan', duplicateTask)

      scanWork.resolve('scan')
      await expect(Promise.all([scan, duplicate])).resolves.toEqual(['scan', 'scan'])
      expect(scanTask).toHaveBeenCalledOnce()
      expect(duplicateTask).not.toHaveBeenCalled()
    } finally {
      exactWork.resolve('late')
      scanWork.resolve('scan')
      await vi.advanceTimersByTimeAsync(0)
      vi.useRealTimers()
    }
  })
})

describe('WSL transcript filesystem task coalescing opt-out', () => {
  const READ_PATH = '\\\\wsl.localhost\\Alpine\\home\\ada\\transcript.jsonl'

  function gatedRead(task: (signal: AbortSignal) => Promise<Buffer>): Promise<Buffer> {
    return runWslTranscriptFsTask(
      { operation: 'read', path: READ_PATH, priority: 'exact', dedupe: false },
      task
    )
  }

  it('fills each caller its own buffer for identical positional reads', async () => {
    const first = Buffer.alloc(4, 0xa1)
    const second = Buffer.alloc(4, 0xb2)
    const bodies = [Buffer.from('AAAA'), Buffer.from('BBBB')]

    const reads = Promise.all([
      gatedRead(async () => {
        bodies.shift()!.copy(first)
        return first
      }),
      gatedRead(async () => {
        bodies.shift()!.copy(second)
        return second
      })
    ])

    await expect(reads).resolves.toEqual([first, second])
    expect(first.toString()).toBe('AAAA')
    expect(second.toString()).toBe('BBBB')
    // Neither caller kept its sentinel nor received the other's bytes.
    expect(first.equals(second)).toBe(false)
  })

  it('gives each open call a distinct handle', async () => {
    const handles = [
      { id: 1, closed: false },
      { id: 2, closed: false }
    ]
    let served = 0
    const opened = await Promise.all(
      handles.map(() =>
        runWslTranscriptFsTask(
          { operation: 'open', path: READ_PATH, priority: 'exact', dedupe: false },
          async () => handles[served++]
        )
      )
    )

    expect(opened[0]).not.toBe(opened[1])
    opened[0].closed = true
    expect(opened[1].closed).toBe(false)
  })

  it('still coalesces identical work when dedupe is omitted', async () => {
    const stalled = deferred<string>()
    const task = vi.fn(() => stalled.promise)
    const path = '\\\\wsl.localhost\\Alpine\\home\\ada'
    const first = run(path, 'scan', task)
    await vi.waitFor(() => expect(task).toHaveBeenCalledOnce())
    const joiner = run(
      path,
      'scan',
      vi.fn(async () => 'never')
    )

    stalled.resolve('shared')
    await expect(Promise.all([first, joiner])).resolves.toEqual(['shared', 'shared'])
    expect(task).toHaveBeenCalledOnce()
  })
})
