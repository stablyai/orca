import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import * as pty from 'node-pty'
import { afterEach, describe, expect, it } from 'vitest'

// Why: when the daemon's libuv threadpool wedges (#8104-class incidents), the
// async fs.write completions inside node-pty's CustomWriteStream never arrive
// and every pty write queues forever with no error. A FIFO reader-open pins a
// threadpool worker until a writer appears, so opening one per worker
// reproduces the wedge deterministically.
const describeOnUnix = process.platform === 'win32' ? describe.skip : describe

const THREADPOOL_SIZE = Number(process.env.UV_THREADPOOL_SIZE || 4)

type CustomWriteStreamClass = {
  new (
    fd: number,
    encoding?: string
  ): {
    write: (data: string) => void
    dispose: () => void
  }
  WRITE_CALLBACK_TIMEOUT_MS: number
  CANARY_TIMEOUT_MS: number
  SYNC_DRAIN_BYTE_BUDGET: number
  probeThreadpool: (done: () => void) => void
}

function loadCustomWriteStream(): CustomWriteStreamClass {
  const requireFromHere = createRequire(import.meta.url)
  const unixTerminal = requireFromHere('node-pty/lib/unixTerminal') as {
    CustomWriteStream: CustomWriteStreamClass
  }
  return unixTerminal.CustomWriteStream
}

type FifoStarvation = {
  release: () => void
}

function starveThreadpool(fifoPath: string): FifoStarvation {
  execFileSync('mkfifo', [fifoPath])
  const openedFds: number[] = []
  for (let i = 0; i < THREADPOOL_SIZE + 2; i++) {
    fs.open(fifoPath, 'r', (err, fd) => {
      if (!err) {
        openedFds.push(fd)
      }
    })
  }
  return {
    release: () => {
      // Why: a FIFO writer-open wakes every pending reader-open. Open it from a
      // background subshell so release itself never blocks.
      execFileSync('sh', ['-c', `echo > "${fifoPath}" &`])
      setTimeout(() => {
        for (const fd of openedFds) {
          try {
            fs.closeSync(fd)
          } catch {
            // already closed
          }
        }
      }, 500).unref()
    }
  }
}

describeOnUnix('node-pty write threadpool stall fallback', () => {
  const cleanups: (() => void)[] = []

  afterEach(() => {
    while (cleanups.length > 0) {
      cleanups.pop()?.()
    }
  })

  it('delivers pty input via sync fallback while the libuv threadpool is stalled', async () => {
    const dir = fs.mkdtempSync(join(tmpdir(), 'pty-stall-'))
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))

    // Shrink the fallback wait so the test runs fast
    const CustomWriteStream = loadCustomWriteStream()
    const originalTimeout = CustomWriteStream.WRITE_CALLBACK_TIMEOUT_MS
    const originalCanary = CustomWriteStream.CANARY_TIMEOUT_MS
    CustomWriteStream.WRITE_CALLBACK_TIMEOUT_MS = 300
    CustomWriteStream.CANARY_TIMEOUT_MS = 200
    cleanups.push(() => {
      CustomWriteStream.WRITE_CALLBACK_TIMEOUT_MS = originalTimeout
      CustomWriteStream.CANARY_TIMEOUT_MS = originalCanary
    })

    const proc = pty.spawn('/bin/sh', ['-c', 'read line; echo "GOT:$line"'], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: process.env as Record<string, string>
    })
    let output = ''
    proc.onData((data) => {
      output += data
    })
    cleanups.push(() => proc.kill())

    // Let the shell reach its `read` before starving the pool
    await delay(300)
    const starvation = starveThreadpool(join(dir, 'stall.fifo'))
    cleanups.push(() => starvation.release())

    // Sanity: async fs completions must no longer come back
    let statDone = false
    fs.stat('/tmp', () => {
      statDone = true
    })
    await delay(300)
    expect(statDone).toBe(false)

    // The first write is sacrificed to the wedged fs.write (abandoned when the
    // fallback engages). What matters is that writes after the fallback reach
    // the shell.
    proc.write('x')
    await delay(700)
    proc.write('hello\n')

    const deadline = Date.now() + 5000
    while (Date.now() < deadline && !output.includes('GOT:')) {
      await delay(100)
    }

    expect(output).toContain('GOT:hello')
  }, 20000)
})

describeOnUnix('CustomWriteStream sync fallback', () => {
  const FAKE_FD = 987654

  type WriteHarness = {
    stream: InstanceType<CustomWriteStreamClass>
    syncWrites: { data: string; turn: number }[]
    syncWriteData: () => string[]
    zeroReturnTurns: number[]
    pendingCallbacks: ((err: NodeJS.ErrnoException | null, written: number) => void)[]
    probeDones: (() => void)[]
    releaseEagain: () => void
    restore: () => void
  }

  // Intercepts fs.write/fs.writeSync for FAKE_FD only, so the stream can be
  // driven without a real pty and without touching vitest's own fs usage.
  // Patches the CJS fs exports object (what the node-pty lib captured via
  // require) — the ESM namespace is frozen and cannot be spied.
  function createHarness(opts?: {
    eagainSyncWrites?: number
    zeroSyncWrites?: number
    canary?: 'stalled' | 'alive' | 'manual'
  }): WriteHarness {
    const CustomWriteStream = loadCustomWriteStream()
    const originalTimeout = CustomWriteStream.WRITE_CALLBACK_TIMEOUT_MS
    const originalCanary = CustomWriteStream.CANARY_TIMEOUT_MS
    const originalProbe = CustomWriteStream.probeThreadpool
    CustomWriteStream.WRITE_CALLBACK_TIMEOUT_MS = 50
    CustomWriteStream.CANARY_TIMEOUT_MS = 30
    // Default to a wedged pool: the canary probe never completes. 'alive'
    // simulates a healthy pool whose one completion is merely late; 'manual'
    // hands each probe's completion to the test for race orchestration.
    const probeDones: (() => void)[] = []
    CustomWriteStream.probeThreadpool = (done: () => void) => {
      const mode = opts?.canary ?? 'stalled'
      if (mode === 'alive') {
        setTimeout(done, 5)
      } else if (mode === 'manual') {
        probeDones.push(done)
      }
    }

    // Tracks event-loop turns so tests can assert work was split across
    // setImmediate boundaries (drain budget, zero-write backpressure).
    let turn = 0
    let turnTrackerDone = false
    const tick = (): void => {
      turn++
      if (!turnTrackerDone) {
        setImmediate(tick)
      }
    }
    setImmediate(tick)

    const syncWrites: WriteHarness['syncWrites'] = []
    const zeroReturnTurns: number[] = []
    const pendingCallbacks: WriteHarness['pendingCallbacks'] = []
    let remainingEagain = opts?.eagainSyncWrites ?? 0
    let remainingZero = opts?.zeroSyncWrites ?? 0

    const cjsFs = createRequire(import.meta.url)('fs') as typeof fs
    const realWrite = cjsFs.write
    const realWriteSync = cjsFs.writeSync

    cjsFs.write = ((fd: number, ...rest: unknown[]) => {
      if (fd !== FAKE_FD) {
        return (realWrite as unknown as (...args: unknown[]) => unknown)(fd, ...rest)
      }
      const callback = rest.at(-1) as WriteHarness['pendingCallbacks'][number]
      pendingCallbacks.push(callback)
      return undefined
    }) as typeof fs.write

    cjsFs.writeSync = ((fd: number, buffer: Buffer, offset?: number, length?: number) => {
      if (fd !== FAKE_FD) {
        return (realWriteSync as unknown as (...args: unknown[]) => number)(
          fd,
          buffer,
          offset,
          length
        )
      }
      if (remainingEagain > 0) {
        remainingEagain--
        const err = new Error('EAGAIN') as NodeJS.ErrnoException
        err.code = 'EAGAIN'
        throw err
      }
      if (remainingZero > 0) {
        remainingZero--
        zeroReturnTurns.push(turn)
        return 0
      }
      const start = offset ?? 0
      const end =
        length === undefined ? buffer.byteLength : Math.min(start + length, buffer.byteLength)
      syncWrites.push({ data: buffer.subarray(start, end).toString('utf8'), turn })
      return end - start
    }) as typeof fs.writeSync

    const stream = new CustomWriteStream(FAKE_FD, 'utf8')
    return {
      stream,
      syncWrites,
      syncWriteData: () => syncWrites.map((w) => w.data),
      zeroReturnTurns,
      probeDones,
      pendingCallbacks,
      releaseEagain: () => {
        remainingEagain = 0
      },
      restore: () => {
        turnTrackerDone = true
        stream.dispose()
        cjsFs.write = realWrite
        cjsFs.writeSync = realWriteSync
        CustomWriteStream.WRITE_CALLBACK_TIMEOUT_MS = originalTimeout
        CustomWriteStream.CANARY_TIMEOUT_MS = originalCanary
        CustomWriteStream.probeThreadpool = originalProbe
      }
    }
  }

  it('abandons the stalled write instead of re-sending it synchronously', async () => {
    const harness = createHarness()
    try {
      harness.stream.write('abc')
      harness.stream.write('def')
      await delay(150)

      // Fallback engaged: 'abc' is abandoned (its in-flight fs.write may still
      // land in the kernel; re-sending it could deliver the bytes twice).
      // 'def' is delivered synchronously.
      expect(harness.syncWriteData()).toEqual(['def'])

      // Later writes keep using the sync path.
      harness.stream.write('ghi')
      expect(harness.syncWriteData()).toEqual(['def', 'ghi'])
    } finally {
      harness.restore()
    }
  })

  it('ignores the stalled completion arriving while sync writes are queued behind EAGAIN', async () => {
    const harness = createHarness({ eagainSyncWrites: Number.MAX_SAFE_INTEGER })
    try {
      harness.stream.write('abc')
      harness.stream.write('def')
      await delay(150)

      // Fallback engaged, but 'def' is still queued: every writeSync hits
      // EAGAIN and the drain is waiting on its retry timer.
      expect(harness.syncWriteData()).toEqual([])

      // The stalled completion finally arrives. Without the guard it would run
      // the async completion logic and shift the queued 'def' out of the queue,
      // silently losing it.
      harness.pendingCallbacks[0]?.(null, 3)

      harness.releaseEagain()
      await delay(100)
      expect(harness.syncWriteData()).toEqual(['def'])
    } finally {
      harness.restore()
    }
  })

  it('never falls back while async completions arrive normally', async () => {
    const harness = createHarness()
    try {
      harness.stream.write('abc')
      // Deliver the async completion promptly, like a healthy threadpool.
      harness.pendingCallbacks.shift()?.(null, 3)
      await delay(150)

      harness.stream.write('def')
      harness.pendingCallbacks.shift()?.(null, 3)
      await delay(50)

      expect(harness.syncWriteData()).toEqual([])
    } finally {
      harness.restore()
    }
  })

  it('retries EAGAIN during the sync drain instead of dropping input', async () => {
    const harness = createHarness({ eagainSyncWrites: 1 })
    try {
      harness.stream.write('abc')
      harness.stream.write('def')
      await delay(200)

      expect(harness.syncWriteData()).toEqual(['def'])
    } finally {
      harness.restore()
    }
  })

  it('does not fall back when the pool is alive and a completion is merely late', async () => {
    const harness = createHarness({ canary: 'alive' })
    try {
      harness.stream.write('abc')
      // Watchdog fires at 50ms, but the canary probe completes (pool alive),
      // so the stream must keep waiting instead of abandoning the write.
      await delay(200)
      expect(harness.syncWriteData()).toEqual([])

      // The late completion finally lands; the async path resumes as normal.
      harness.pendingCallbacks.shift()?.(null, 3)
      harness.stream.write('def')
      await delay(50)

      expect(harness.syncWriteData()).toEqual([])
      expect(harness.pendingCallbacks.length).toBe(1)
    } finally {
      harness.restore()
    }
  })

  it('splits a large sync drain across event-loop turns instead of hogging one', async () => {
    const harness = createHarness()
    try {
      const CustomWriteStream = loadCustomWriteStream()
      const originalBudget = CustomWriteStream.SYNC_DRAIN_BYTE_BUDGET
      CustomWriteStream.SYNC_DRAIN_BYTE_BUDGET = 4
      try {
        harness.stream.write('abc')
        harness.stream.write('def')
        harness.stream.write('ghi')
        harness.stream.write('jkl')
        await delay(200)

        // All queued input (minus the abandoned head) must still arrive, in
        // order (tasks may be split by the per-turn byte cap)…
        expect(harness.syncWriteData().join('')).toBe('defghijkl')
        // …but not all inside a single event-loop turn.
        const turns = new Set(harness.syncWrites.map((w) => w.turn))
        expect(turns.size).toBeGreaterThan(1)
      } finally {
        CustomWriteStream.SYNC_DRAIN_BYTE_BUDGET = originalBudget
      }
    } finally {
      harness.restore()
    }
  })

  it('ignores a stale canary completion from an earlier write (generation race)', async () => {
    const harness = createHarness({ canary: 'manual' })
    try {
      // Write A stalls long enough for its watchdog to dispatch canary A.
      harness.stream.write('A')
      await delay(60)
      expect(harness.probeDones.length).toBe(1)

      // A's completion arrives before canary A's timer expires; write B then
      // stalls and dispatches canary B.
      harness.pendingCallbacks.shift()?.(null, 1)
      harness.stream.write('B')
      await delay(60)
      expect(harness.probeDones.length).toBe(2)

      // The STALE canary-A completion lands while canary B is deciding. It
      // must not cancel canary B's timer — otherwise write B is stuck forever
      // with no watchdog and no canary (the exact hang this patch fixes).
      harness.probeDones[0]?.()
      await delay(100)

      // Canary B must still have timed out and engaged the fallback: B was
      // abandoned, and a subsequent write goes through synchronously.
      harness.stream.write('C')
      await delay(50)
      expect(harness.syncWriteData()).toEqual(['C'])
    } finally {
      harness.restore()
    }
  })

  it('caps each sync writeSync call at the remaining turn budget', async () => {
    const harness = createHarness()
    try {
      const CustomWriteStream = loadCustomWriteStream()
      const originalBudget = CustomWriteStream.SYNC_DRAIN_BYTE_BUDGET
      CustomWriteStream.SYNC_DRAIN_BYTE_BUDGET = 4
      try {
        harness.stream.write('x')
        harness.stream.write('abcdefghij')
        await delay(200)

        // The 10-byte task must arrive in full…
        expect(harness.syncWriteData().join('')).toBe('abcdefghij')
        // …but no single event-loop turn may exceed the byte budget — a
        // single large task must not bypass it in one syscall.
        const perTurn = new Map<number, number>()
        for (const w of harness.syncWrites) {
          perTurn.set(w.turn, (perTurn.get(w.turn) ?? 0) + w.data.length)
        }
        for (const bytes of perTurn.values()) {
          expect(bytes).toBeLessThanOrEqual(4)
        }
      } finally {
        CustomWriteStream.SYNC_DRAIN_BYTE_BUDGET = originalBudget
      }
    } finally {
      harness.restore()
    }
  })

  it('defers the wedge verdict when the event loop itself was stalled', async () => {
    const harness = createHarness()
    try {
      harness.stream.write('x')
      harness.stream.write('y')
      // Let the watchdog fire and the canary timer arm…
      await delay(60)
      // …then stall the event loop synchronously past the canary deadline.
      // When the loop resumes, the canary timer fires hugely late — that
      // lateness proves the loop (not necessarily the pool) was stalled, so
      // the verdict must be deferred to a fresh probe cycle.
      const blockUntil = Date.now() + 150
      while (Date.now() < blockUntil) {
        // busy-wait to stall the loop
      }
      // Yield once so the overdue canary timer gets to run its callback.
      await delay(10)
      expect(harness.syncWriteData()).toEqual([])

      // The pool really is wedged here (probe never completes), so a fresh
      // undisturbed probe cycle must still reach the fallback.
      await delay(300)
      expect(harness.syncWriteData()).toEqual(['y'])
    } finally {
      harness.restore()
    }
  })

  it('treats a zero-byte writeSync as backpressure and retries later instead of spinning', async () => {
    const harness = createHarness({ zeroSyncWrites: 1 })
    try {
      harness.stream.write('abc')
      harness.stream.write('def')
      await delay(200)

      expect(harness.syncWriteData()).toEqual(['def'])
      // The retry after the zero-byte write must happen in a later turn —
      // a tight same-turn loop would spin the event loop on backpressure.
      const firstWrite = harness.syncWrites.at(0)
      expect(firstWrite).toBeDefined()
      expect(harness.zeroReturnTurns.length).toBe(1)
      expect(firstWrite!.turn).toBeGreaterThan(harness.zeroReturnTurns[0]!)
    } finally {
      harness.restore()
    }
  })
})
