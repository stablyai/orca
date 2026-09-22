import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readZcodeSqliteTranscriptViaWorker } from '../ai-vault/session-scanner-opencode-sqlite-worker-spawn'
import { readZcodeTranscriptTail } from './zcode-transcript-tail'

vi.mock('../ai-vault/session-scanner-opencode-sqlite-worker-spawn', () => ({
  readZcodeSqliteTranscriptViaWorker: vi.fn()
}))

describe('readZcodeTranscriptTail', () => {
  beforeEach(() => {
    vi.mocked(readZcodeSqliteTranscriptViaWorker).mockReset()
  })

  it('marks ENOENT failures as notFound even when the message differs', async () => {
    vi.mocked(readZcodeSqliteTranscriptViaWorker).mockRejectedValue(
      Object.assign(new Error('database unavailable'), { code: 'ENOENT' })
    )

    await expect(readZcodeTranscriptTail({ sessionId: 'session-1', limit: 20 })).resolves.toEqual({
      error: 'database unavailable',
      notFound: true
    })
  })
})
