import { Worker } from 'node:worker_threads'
import { describe, expect, it } from 'vitest'
import {
  createHangWatchdogSpanTracker,
  HANG_WATCHDOG_SPAN_CAPACITY,
  readHangWatchdogSpanSnapshot,
  parseHangWatchdogSpanSnapshot
} from './hang-watchdog-active-spans'

describe('watchdog active spans', () => {
  it('keeps nested operations distinct, frees completed slots and ignores arbitrary names', () => {
    const tracker = createHangWatchdogSpanTracker()
    tracker.observer.started('outer', 'git.exec', 100)
    tracker.observer.started('inner', 'git.exec', 150)
    tracker.observer.started('secret', '/private/repo?token=secret', 100)
    expect(readHangWatchdogSpanSnapshot(tracker.buffer, 200)).toEqual({
      inFlightSpans: [
        { name: 'git.exec', elapsedMs: 50 },
        { name: 'git.exec', elapsedMs: 100 }
      ],
      droppedSpanCount: 0
    })
    tracker.observer.ended('inner')
    tracker.observer.ended('inner')
    tracker.observer.started('replacement', 'worktree.create', 180)
    expect(readHangWatchdogSpanSnapshot(tracker.buffer, 200).inFlightSpans).toEqual([
      { name: 'worktree.create', elapsedMs: 20 },
      { name: 'git.exec', elapsedMs: 100 }
    ])
    tracker.clear()
    expect(readHangWatchdogSpanSnapshot(tracker.buffer, 200).inFlightSpans).toEqual([])
  })

  it('bounds active storage, reports lifetime overflow, and reuses released slots', () => {
    const tracker = createHangWatchdogSpanTracker()
    for (let i = 0; i < 10_000; i++) {
      tracker.observer.started(String(i), 'git.exec', 100)
    }
    const full = readHangWatchdogSpanSnapshot(tracker.buffer, 200)
    expect(full.inFlightSpans).toHaveLength(HANG_WATCHDOG_SPAN_CAPACITY)
    expect(full.droppedSpanCount).toBe(10_000 - HANG_WATCHDOG_SPAN_CAPACITY)
    for (let i = 0; i < 10_000; i++) {
      tracker.observer.ended(String(i))
    }
    tracker.observer.started('new', 'git.exec', 200)
    expect(readHangWatchdogSpanSnapshot(tracker.buffer, 250).inFlightSpans).toEqual([
      { name: 'git.exec', elapsedMs: 50 }
    ])
  })

  it('keeps name and timestamp atomic during concurrent slot reuse', async () => {
    const tracker = createHangWatchdogSpanTracker()
    const worker = new Worker(
      `
      const {parentPort,workerData}=require('node:worker_threads');
      const slots=new BigInt64Array(workerData);
      for(let i=0;i<100000;i++){
        Atomics.store(slots,1,100n*256n+1n);
        Atomics.store(slots,1,200n*256n+2n);
      }
      parentPort.postMessage('done');
    `,
      { eval: true, workerData: tracker.buffer }
    )
    try {
      const finished = new Promise<void>((resolve, reject) => {
        worker.once('message', () => resolve())
        worker.once('error', reject)
      })
      for (let i = 0; i < 10_000; i++) {
        const span = readHangWatchdogSpanSnapshot(tracker.buffer, 300).inFlightSpans[0]
        if (span) {
          expect(span).toEqual(
            span.name === 'git.exec'
              ? { name: 'git.exec', elapsedMs: 200 }
              : { name: 'secure-path.windows-acl', elapsedMs: 100 }
          )
        }
      }
      await finished
    } finally {
      await worker.terminate()
    }
  })

  it('validates operation data without retaining attributes or unknown names', () => {
    expect(
      parseHangWatchdogSpanSnapshot({
        inFlightSpans: [
          { name: 'git.exec', elapsedMs: 42, command: 'secret' },
          { name: 'secret', elapsedMs: 5 },
          { name: 'git.exec', elapsedMs: -1 }
        ],
        droppedSpanCount: 3
      })
    ).toEqual({ inFlightSpans: [{ name: 'git.exec', elapsedMs: 42 }], droppedSpanCount: 3 })
  })
})
