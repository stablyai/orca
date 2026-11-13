import { readRuntimeElapsedClock } from '../../hosts/runtime-elapsed-clock'
import { TERMINAL_INPUT_MAX_BYTES } from '../../../../shared/terminal/input/terminal-input'
import type { TerminalRunFactsRegister } from '../lifecycle/terminal-run-facts'

export type TerminalChatInput = {
  frames: string[] | null
  signal: AbortSignal
  start: (executionMs?: number) => void
  assertActive: () => void
  finish: () => void
}

type InputRecord = {
  tail: Promise<void> | null
  entries: Set<TerminalChatInput & { cancel: () => void }>
  writingChat: boolean
  unsubscribe?: () => void
}

/** Typed Chat lifetime and the existing generated-prompt ordering share one process owner. */
export class TerminalPromptInputQueue {
  private retainedBytes = 0
  private readonly records = new Map<string, InputRecord>()

  constructor(private readonly facts: TerminalRunFactsRegister) {}

  private record(ptyId: string, generation: number): InputRecord {
    const key = `${ptyId}\0${generation}`
    let record = this.records.get(key)
    if (!record) {
      record = { tail: null, entries: new Set(), writingChat: false }
      this.records.set(key, record)
    }
    return record
  }

  private releaseRecord(ptyId: string, generation: number, record: InputRecord): void {
    if (record.entries.size === 0) {
      record.unsubscribe?.()
      record.unsubscribe = undefined
      if (record.tail === null) {
        this.records.delete(`${ptyId}\0${generation}`)
      }
    }
  }

  async serialize<T>(ptyId: string, generation: number, submit: () => Promise<T>): Promise<T> {
    const record = this.record(ptyId, generation)
    const submission = (record.tail ?? Promise.resolve()).catch(() => undefined).then(submit)
    const tail = submission.then(
      () => {},
      () => {}
    )
    record.tail = tail
    try {
      return await submission
    } finally {
      if (record.tail === tail) {
        record.tail = null
      }
      this.releaseRecord(ptyId, generation, record)
    }
  }

  withChatWrite<T>(ptyId: string, generation: number, write: () => T): T {
    const record = this.record(ptyId, generation)
    const previous = record.writingChat
    record.writingChat = true
    try {
      return write()
    } finally {
      record.writingChat = previous
    }
  }

  admit(
    ptyId: string,
    generation: number,
    frames: string[],
    retainedBytes: number,
    lifecycle: AbortSignal,
    timing?: { expiresAtMs: number; executionMs: number },
    signal?: AbortSignal
  ): TerminalChatInput | null {
    if (lifecycle.aborted || retainedBytes > TERMINAL_INPUT_MAX_BYTES - this.retainedBytes) {
      return null
    }
    const record = this.record(ptyId, generation)
    if (record.entries.size >= 8) {
      return null
    }
    const clock = timing ? readRuntimeElapsedClock() : null
    if (timing && (!clock || clock.upper >= timing.expiresAtMs)) {
      this.releaseRecord(ptyId, generation, record)
      return null
    }
    this.retainedBytes += retainedBytes
    const controller = new AbortController()
    let started = false
    let finished = false
    const finish = (): void => {
      if (finished) {
        return
      }
      finished = true
      entry.frames = null
      this.retainedBytes -= retainedBytes
      clearTimeout(timer)
      lifecycle.removeEventListener('abort', cancel)
      signal?.removeEventListener('abort', cancel)
      record.entries.delete(entry)
      this.releaseRecord(ptyId, generation, record)
    }
    const cancel = (): void => {
      controller.abort()
      if (!started) {
        finish()
      }
    }
    let deadline = timing ? Math.min(timing.expiresAtMs, clock!.lower + 30_000) : 0
    const assertActive = (): void => {
      if (timing) {
        const now = readRuntimeElapsedClock()
        if (!now || now.upper >= deadline) {
          cancel()
        }
      }
      controller.signal.throwIfAborted()
    }
    const wake = (): void => {
      try {
        assertActive()
        arm()
      } catch {
        /* Expiry retires through the same cancellation owner. */
      }
    }
    let timer: ReturnType<typeof setTimeout>
    const arm = (): void => {
      const now = timing ? readRuntimeElapsedClock() : null
      if (timing && !now) {
        cancel()
        return
      }
      timer = setTimeout(
        timing ? wake : cancel,
        timing ? Math.max(1, deadline - now!.upper) : 30_000
      )
    }
    const entry: TerminalChatInput & { cancel: () => void } = {
      frames,
      signal: controller.signal,
      assertActive,
      start: (executionMs) => {
        if (controller.signal.aborted) {
          return
        }
        try {
          assertActive()
        } catch {
          return
        }
        started = true
        clearTimeout(timer)
        if (timing) {
          const now = readRuntimeElapsedClock()
          if (!now) {
            cancel()
            return
          }
          deadline = Math.min(timing.expiresAtMs, now.lower + (executionMs ?? timing.executionMs))
        }
        arm()
      },
      finish,
      cancel
    }
    record.entries.add(entry)
    arm()
    record.unsubscribe ??= this.facts.onPtyInput(ptyId, () => {
      if (!record.writingChat) {
        for (const input of record.entries) {
          input.cancel()
        }
      }
    })
    lifecycle.addEventListener('abort', cancel, { once: true })
    signal?.addEventListener('abort', cancel, { once: true })
    if (lifecycle.aborted || signal?.aborted) {
      cancel()
    }
    return entry
  }
}
