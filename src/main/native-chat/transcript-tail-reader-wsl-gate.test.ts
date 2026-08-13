import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  resolve: vi.fn<() => Promise<string | null>>()
}))

vi.mock('./session-file-resolver', () => ({
  resolveSessionFilePath: mocks.resolve
}))

import { readNativeChatTranscriptTail } from './transcript-tail-reader'
import { WslTranscriptFsError } from './wsl-transcript-fs-gate'

describe('native chat transcript tail under WSL gate refusals', () => {
  beforeEach(() => {
    mocks.resolve.mockReset()
  })

  it('reports a gate refusal as a retryable error, not a missing transcript', async () => {
    mocks.resolve.mockRejectedValueOnce(new WslTranscriptFsError('timeout', 'slow share'))

    await expect(
      readNativeChatTranscriptTail({ agent: 'codex', sessionId: 'session-id', limit: 10 })
    ).resolves.toEqual({ error: 'slow share' })
  })

  it('rethrows non-gate resolver failures', async () => {
    mocks.resolve.mockRejectedValueOnce(new Error('resolver crashed'))

    await expect(
      readNativeChatTranscriptTail({ agent: 'codex', sessionId: 'session-id', limit: 10 })
    ).rejects.toThrow('resolver crashed')
  })
})
