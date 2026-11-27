import { describe, expect, it, vi } from 'vitest'
import { countOmpSubagentTranscripts } from './session-scanner-omp-subagent-transcripts'

const readdir = vi.hoisted(() => vi.fn())

vi.mock(
  '../../../native-chat/transcript-filesystem/wsl-transcript-fs-access',
  async (original) => ({
    ...(await original<Record<string, unknown>>()),
    wslGatedReaddir: readdir
  })
)

const PARENT_PATH = '/sessions/2026-05-01T10-00-00-000Z_cccccccc-dddd-4eee-8fff-000000000000.jsonl'

describe('countOmpSubagentTranscripts', () => {
  it('keeps the count unknown when the artifact directory cannot be read', async () => {
    readdir.mockRejectedValueOnce(Object.assign(new Error('EIO'), { code: 'EIO' }))

    await expect(countOmpSubagentTranscripts(PARENT_PATH)).resolves.toBeNull()
  })

  it('counts a missing artifact directory as zero', async () => {
    readdir.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))

    await expect(countOmpSubagentTranscripts(PARENT_PATH)).resolves.toBe(0)
  })
})
