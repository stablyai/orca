import type { Dirent } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ readdir: vi.fn(), gatedReaddir: vi.fn() }))
vi.mock('node:fs/promises', () => ({ readdir: mocks.readdir }))
vi.mock('../native-chat/wsl-transcript-fs-access', () => ({ wslGatedReaddir: mocks.gatedReaddir }))
vi.mock('../claude-accounts/claude-profile-installed-router', () => ({
  claudeProfileHistoryDirs: () => []
}))
const ROOT = String.raw`\\wsl.localhost\Ubuntu\home\ada\.claude-alt\projects`
const FILE = `${ROOT}\\session.jsonl`
const entry: Dirent = {
  name: 'session.jsonl',
  parentPath: ROOT,
  isFile: () => true,
  isDirectory: () => false,
  isBlockDevice: () => false,
  isCharacterDevice: () => false,
  isFIFO: () => false,
  isSocket: () => false,
  isSymbolicLink: () => false
}

describe('selected WSL profile discovery', () => {
  beforeEach(() => {
    mocks.readdir.mockReset().mockRejectedValue(new Error('native access must not scan WSL'))
    mocks.gatedReaddir.mockReset().mockResolvedValue([entry])
  })
  it('uses only the explicit profile roots and gated UNC directory access', async () => {
    const { listClaudeTranscriptFiles } = await import('./transcript-file-discovery')
    await expect(listClaudeTranscriptFiles([ROOT])).resolves.toEqual([FILE])
    expect(mocks.gatedReaddir).toHaveBeenCalledWith(ROOT, 'scan')
    expect(mocks.readdir).not.toHaveBeenCalled()
  })
  it('keeps unavailable profiles as an error, but treats definitive absence as empty', async () => {
    const { listClaudeTranscriptFiles } = await import('./transcript-file-discovery')
    mocks.gatedReaddir.mockRejectedValueOnce(new Error('WSL unavailable'))
    await expect(listClaudeTranscriptFiles([ROOT])).rejects.toThrow('WSL unavailable')
    mocks.gatedReaddir.mockRejectedValueOnce(
      Object.assign(new Error('missing'), { code: 'ENOENT' })
    )
    await expect(listClaudeTranscriptFiles([ROOT])).resolves.toEqual([])
  })
})
