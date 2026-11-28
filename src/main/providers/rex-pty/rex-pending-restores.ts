import {
  throwIfSignalAborted,
  waitForPromiseWithSignal
} from '../../../shared/concurrency/abort-signal-reason'

import { runKeyedSerializedOperation } from '../../../shared/concurrency/keyed-serialized-operations'

type Pending = { tail: Buffer; nonce: bigint; continuation: Buffer }

/** A renderer that never activates its restored view must not retain a snapshot tail forever. */
export class RexPendingRestores {
  private readonly entries = new Map<
    string,
    {
      value: Pending
      timer: ReturnType<typeof setTimeout>
      settled: Promise<boolean>
      release: (activated: boolean) => void
    }
  >()
  private readonly attaching = new Map<string, Promise<void>>()
  private readonly waitingAttaches = new Set<string>()

  constructor(private readonly timeoutMs = 15_000) {}

  has(id: string): boolean {
    return this.entries.has(id)
  }
  get(id: string): Pending | undefined {
    return this.entries.get(id)?.value
  }

  wait(id: string, signal?: AbortSignal): Promise<boolean> {
    return waitForPromiseWithSignal(this.entries.get(id)?.settled ?? Promise.resolve(true), signal)
  }

  serializeAttach<T>(
    id: string,
    signal: AbortSignal | undefined,
    capture: () => Promise<T>
  ): Promise<T> {
    const queued = this.attaching.has(id)
    if (queued && this.waitingAttaches.has(id)) {
      return Promise.reject(new Error('Rex attach queue full'))
    }
    if (queued) {
      this.waitingAttaches.add(id)
    }
    return runKeyedSerializedOperation(this.attaching, id, async () => {
      if (queued) {
        this.waitingAttaches.delete(id)
      }
      // Main adoption and renderer attachment need distinct snapshots, never the same tail.
      throwIfSignalAborted(signal)
      if (!(await this.wait(id, signal))) {
        throw new Error('Rex previous restore was not activated')
      }
      throwIfSignalAborted(signal)
      return capture()
    })
  }

  set(id: string, value: Pending, expire: () => void): void {
    this.delete(id)
    const { promise: settled, resolve: release } = Promise.withResolvers<boolean>()
    const timer = setTimeout(() => {
      this.delete(id)
      expire()
    }, this.timeoutMs)
    timer.unref?.()
    this.entries.set(id, { value, timer, settled, release })
  }

  delete(id: string, activated = false): void {
    const previous = this.entries.get(id)
    if (previous) {
      clearTimeout(previous.timer)
      this.entries.delete(id)
      previous.release(activated)
    }
  }
}
