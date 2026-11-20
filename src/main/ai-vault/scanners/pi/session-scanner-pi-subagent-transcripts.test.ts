import { describe, expect, it, vi } from 'vitest'
import { countPiSubagentTranscripts } from './session-scanner-pi-subagent-transcripts'

const readdir = vi.hoisted(() => vi.fn())

vi.mock(
  '../../../native-chat/transcript-filesystem/wsl-transcript-fs-access',
  async (original) => ({
    ...(await original<Record<string, unknown>>()),
    wslGatedReaddir: readdir
  })
)

const PARENT_PATH = '/sessions/2026-05-01T10-00-00-000Z_cccccccc-dddd-4eee-8fff-000000000000.jsonl'

function fsError(code: string): Error {
  return Object.assign(new Error(code), { code })
}

function entry(name: string, kind: 'file' | 'dir') {
  return { name, isFile: () => kind === 'file', isDirectory: () => kind === 'dir' }
}

describe('countPiSubagentTranscripts', () => {
  it('keeps the count unknown when the child directory cannot be read', async () => {
    readdir.mockRejectedValueOnce(fsError('EIO'))

    await expect(countPiSubagentTranscripts(PARENT_PATH)).resolves.toBeNull()
  })

  it('counts a missing child directory as zero', async () => {
    readdir.mockRejectedValueOnce(fsError('ENOENT'))

    await expect(countPiSubagentTranscripts(PARENT_PATH)).resolves.toBe(0)
  })

  it('keeps the count unknown when only part of the walk reads', async () => {
    readdir
      .mockResolvedValueOnce([entry('d4306da3-ab96-4236-bf98-8865dc4ce978', 'dir')])
      .mockRejectedValueOnce(fsError('EACCES'))

    await expect(countPiSubagentTranscripts(PARENT_PATH)).resolves.toBeNull()
  })
})
