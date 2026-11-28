import { afterEach, expect, it, vi } from 'vitest'

const tailRead = vi.hoisted(() => {
  const reads: string[] = []
  return { reads, release: () => {} }
})
vi.mock('./claude-transcript-tail-text', () => ({
  readClaudeTranscriptTailText: (path: string) => {
    tailRead.reads.push(path)
    return path === 'hung.jsonl'
      ? new Promise((resolve) => {
          tailRead.release = () => resolve(null)
        })
      : Promise.resolve(null)
  }
}))

afterEach(() => {
  vi.useRealTimers()
})

// The checks share one queue, and each only labels a notice: a read that never returns (a stale
// network mount) must hold no notice past 5 s from its call, and must not pile up more reads.
it('settles every check within 5 s of its call, and reads nothing more while a read is stuck', async () => {
  vi.useFakeTimers()
  const { readClaudeToolReturnWithoutRequest } =
    await import('./claude-tool-return-without-request')
  const check = (transcriptPath: string) =>
    readClaudeToolReturnWithoutRequest({ transcriptPath, quietMs: 1, stillWanted: () => true })
  const settled: string[] = []
  const hung = check('hung.jsonl').then(() => settled.push('hung'))
  await vi.advanceTimersByTimeAsync(1_000)
  // Queued a second later: the hung check's deadline frees the queue while its own has 1 s left.
  const queued = check('queued.jsonl').then(() => settled.push('queued'))
  await vi.advanceTimersByTimeAsync(3_999)
  expect(settled).toEqual([])
  await vi.advanceTimersByTimeAsync(1)
  await Promise.all([hung, queued])
  // The hung read is still out, so the queued check settled at once and read nothing.
  expect(settled).toEqual(['hung', 'queued'])
  expect(tailRead.reads).toEqual(['hung.jsonl'])
  await expect(check('later.jsonl')).resolves.toBeNull()
  expect(tailRead.reads).toEqual(['hung.jsonl'])
  tailRead.release()
  await vi.advanceTimersByTimeAsync(0)
  await expect(check('later.jsonl')).resolves.toBeNull()
  expect(tailRead.reads).toEqual(['hung.jsonl', 'later.jsonl'])
})
