import { describe, expect, it } from 'vitest'
import type { CodexHistoryDiskUsage } from '../../../../shared/workspace-cleanup/codex-history-disk-usage'
import { createCodexHistoryDiskUsageReader } from './codex-history-disk-usage-reader'

const before = { bytes: 11_000, rollouts: 3, complete: true }
const after = { bytes: 2_000, rollouts: 1, complete: true }

/** A walk that ends with `usage`, or rejects as soon as its signal aborts. */
function walk(usage: CodexHistoryDiskUsage): {
  measure: (signal: AbortSignal) => Promise<CodexHistoryDiskUsage>
  finish: () => void
  aborted: () => boolean
} {
  let finish!: () => void
  let signal: AbortSignal | null = null
  return {
    measure: (s) => {
      signal = s
      return new Promise((resolve, reject) => {
        finish = () => resolve(usage)
        s.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    },
    finish: () => finish(),
    aborted: () => signal?.aborted === true
  }
}

describe('createCodexHistoryDiskUsageReader', () => {
  it('stops a walk a deletion made obsolete and answers later reads from a fresh one', async () => {
    const reader = createCodexHistoryDiskUsageReader(60_000, () => 0)
    const first = walk(before)
    const second = walk(after)
    const stale = reader.read(first.measure)
    reader.forget()
    const fresh = reader.read(second.measure)
    second.finish()

    expect(first.aborted()).toBe(true)
    await expect(stale).rejects.toThrow('aborted')
    await expect(fresh).resolves.toEqual(after)
    await expect(reader.read(walk(before).measure)).resolves.toEqual(after)
  })
})

describe('releasing a Codex history size read', () => {
  it('keeps the walk while another reader waits and stops it when the last one leaves', async () => {
    const reader = createCodexHistoryDiskUsageReader(60_000, () => 0)
    const running = walk(before)
    const first = reader.read(running.measure, 'window-a')
    void reader.read(running.measure, 'window-b').catch(() => undefined)

    reader.release('window-a')
    expect(running.aborted()).toBe(false)
    reader.release('window-b')

    expect(running.aborted()).toBe(true)
    await expect(first).rejects.toThrow('aborted')
  })
})
