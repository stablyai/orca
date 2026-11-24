import { afterEach, expect, it, vi } from 'vitest'

const tailRead = vi.hoisted(() => ({ hang: true }))
vi.mock('./claude-transcript-tail-text', () => ({
  readClaudeTranscriptTailText: (path: string) =>
    path === 'hung.jsonl' && tailRead.hang ? new Promise(() => {}) : Promise.resolve(null)
}))

afterEach(() => {
  vi.useRealTimers()
})

// The checks share one queue: a read that never returns (a stale network mount) must give the old
// wording and leave the queue free for every other worker's check.
it('gives up on a read that never returns and still runs the next check', async () => {
  vi.useFakeTimers()
  const { readClaudeToolReturnWithoutRequest } =
    await import('./claude-tool-return-without-request')
  const check = (transcriptPath: string) =>
    readClaudeToolReturnWithoutRequest({ transcriptPath, quietMs: 1, stillWanted: () => true })
  const hung = check('hung.jsonl')
  let nextDone = false
  const next = check('other.jsonl').then((at) => {
    nextDone = true
    return at
  })
  await vi.advanceTimersByTimeAsync(4_999)
  expect(nextDone).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  await expect(hung).resolves.toBeNull()
  await expect(next).resolves.toBeNull()
})
