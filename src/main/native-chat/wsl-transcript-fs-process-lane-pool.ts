import {
  WSL_TRANSCRIPT_FS_PROCESS_IDLE_REAP_MS,
  type ProcessSlot
} from './wsl-transcript-fs-process-slot'
import { wslTranscriptFsProcessFailureError } from './wsl-transcript-fs-error'

type SlotWaiter = {
  resolve: (slot: ProcessSlot) => void
  reject: (error: unknown) => void
  signal: AbortSignal
  onAbort: () => void
}

export class WslTranscriptFsProcessLanePool {
  private readonly available: ProcessSlot[] = []
  private readonly slots = new Set<ProcessSlot>()
  private readonly waiters: SlotWaiter[] = []
  private disposed = false
  private disposeError: unknown = new Error('WSL transcript filesystem process pool is disposed')

  constructor(
    private readonly createSlot: () => ProcessSlot,
    private readonly retireIdleSlot: (slot: ProcessSlot) => void
  ) {}

  acquire(signal: AbortSignal, prioritize = false): ProcessSlot | Promise<ProcessSlot> {
    signal.throwIfAborted()
    if (this.disposed) {
      return Promise.reject(this.disposeError)
    }
    const slot = this.available.pop()
    if (slot) {
      clearTimeout(slot.idleTimer)
      return slot
    }
    if (this.slots.size === 0) {
      return this.addSlot()
    }
    return new Promise<ProcessSlot>((resolve, reject) => {
      const waiter: SlotWaiter = {
        resolve,
        reject,
        signal,
        onAbort: () => {
          const index = this.waiters.indexOf(waiter)
          if (index !== -1) {
            this.waiters.splice(index, 1)
          }
          reject(signal.reason ?? new Error('WSL filesystem process acquisition aborted'))
        }
      }
      signal.addEventListener('abort', waiter.onAbort, { once: true })
      if (prioritize) {
        this.waiters.unshift(waiter)
      } else {
        this.waiters.push(waiter)
      }
    })
  }

  park(slot: ProcessSlot): void {
    if (!this.slots.has(slot)) {
      return
    }
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter.signal.removeEventListener('abort', waiter.onAbort)
      waiter.resolve(slot)
      return
    }
    if (this.available.includes(slot)) {
      return
    }
    this.available.push(slot)
    if (slot.handles.size === 0) {
      slot.idleTimer = setTimeout(
        () => this.retireIdleSlot(slot),
        WSL_TRANSCRIPT_FS_PROCESS_IDLE_REAP_MS
      )
      slot.idleTimer.unref?.()
    }
  }

  has(slot: ProcessSlot): boolean {
    return this.slots.has(slot)
  }

  claim(slot: ProcessSlot, signal: AbortSignal, release?: () => void): ProcessSlot {
    if (!this.slots.has(slot)) {
      throw this.disposed
        ? this.disposeError
        : wslTranscriptFsProcessFailureError('the process exited before the queued request started')
    }
    if (signal.aborted) {
      if (release) {
        release()
      } else {
        this.park(slot)
      }
      signal.throwIfAborted()
    }
    return slot
  }

  snapshot(): ProcessSlot[] {
    return [...this.slots]
  }

  beginDispose(error: unknown): void {
    this.disposed = true
    this.disposeError = error
    for (const waiter of this.waiters.splice(0)) {
      waiter.signal.removeEventListener('abort', waiter.onAbort)
      waiter.reject(error)
    }
  }

  retire(slot: ProcessSlot): boolean {
    if (!this.slots.delete(slot)) {
      return false
    }
    clearTimeout(slot.idleTimer)
    const availableIndex = this.available.indexOf(slot)
    if (availableIndex !== -1) {
      this.available.splice(availableIndex, 1)
    }
    this.replaceForWaiter()
    return true
  }

  private addSlot(): ProcessSlot {
    const slot = this.createSlot()
    this.slots.add(slot)
    return slot
  }

  private replaceForWaiter(): void {
    if (this.disposed || this.slots.size > 0) {
      return
    }
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!
      waiter.signal.removeEventListener('abort', waiter.onAbort)
      if (waiter.signal.aborted) {
        waiter.reject(waiter.signal.reason)
        continue
      }
      try {
        waiter.resolve(this.addSlot())
        return
      } catch (error) {
        waiter.reject(error)
      }
    }
  }
}
