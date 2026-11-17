import { describe, expect, it } from 'vitest'
import type { CodexHistoryDiskUsage } from '../../../../shared/workspace-cleanup/codex-history-disk-usage'
import { createCodexHistoryDiskUsageReader } from './codex-history-disk-usage-reader'

function deferred(): {
  promise: Promise<CodexHistoryDiskUsage>
  resolve: (usage: CodexHistoryDiskUsage) => void
} {
  let resolve!: (usage: CodexHistoryDiskUsage) => void
  const promise = new Promise<CodexHistoryDiskUsage>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const before = { bytes: 11_000, rollouts: 3, complete: true }
const after = { bytes: 2_000, rollouts: 1, complete: true }

describe('createCodexHistoryDiskUsageReader', () => {
  it('never answers a read after a deletion with a walk that started before it', async () => {
    const reader = createCodexHistoryDiskUsageReader(60_000, () => 0)
    const first = deferred()
    const second = deferred()
    const stale = reader.read(() => first.promise)
    reader.forget()
    const fresh = reader.read(() => second.promise)
    first.resolve(before)
    second.resolve(after)

    await expect(stale).resolves.toEqual(before)
    await expect(fresh).resolves.toEqual(after)
    await expect(reader.read(() => Promise.resolve(before))).resolves.toEqual(after)
  })
})
