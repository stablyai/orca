import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as FsPromises from 'node:fs/promises'
import type * as WslTranscriptFsAccess from '../native-chat/wsl-transcript-fs-access'

const {
  aggregateClaudeUsageMock,
  attributeClaudeUsageTurnsMock,
  buildWorktreeLookupMock,
  finalizeClaudeSessionsMock,
  listClaudeTranscriptFilesMock,
  mergeClaudeDailyAggregatesMock,
  mergeClaudeSessionsMock,
  readClaudeUsageScanFileMock,
  statMock,
  wslGatedStatMock
} = vi.hoisted(() => ({
  aggregateClaudeUsageMock: vi.fn(),
  attributeClaudeUsageTurnsMock: vi.fn(),
  buildWorktreeLookupMock: vi.fn(),
  finalizeClaudeSessionsMock: vi.fn(),
  listClaudeTranscriptFilesMock: vi.fn(),
  mergeClaudeDailyAggregatesMock: vi.fn(),
  mergeClaudeSessionsMock: vi.fn(),
  readClaudeUsageScanFileMock: vi.fn(),
  statMock: vi.fn(),
  wslGatedStatMock: vi.fn()
}))

vi.mock('./transcript-file-discovery', () => ({
  listClaudeTranscriptFiles: listClaudeTranscriptFilesMock
}))

vi.mock('./transcript-record-parser', () => ({
  readClaudeUsageScanFile: readClaudeUsageScanFileMock,
  stripClaudeSourceMetadata: (turn: unknown) => turn
}))

vi.mock('./worktree-attribution', () => ({
  attributeClaudeUsageTurns: attributeClaudeUsageTurnsMock,
  buildWorktreeLookup: buildWorktreeLookupMock
}))

vi.mock('./usage-aggregation', () => ({
  aggregateClaudeUsage: aggregateClaudeUsageMock,
  finalizeClaudeSessions: finalizeClaudeSessionsMock,
  mergeClaudeDailyAggregates: mergeClaudeDailyAggregatesMock,
  mergeClaudeSessions: mergeClaudeSessionsMock
}))

vi.mock('fs/promises', async () => ({
  ...(await vi.importActual<typeof FsPromises>('fs/promises')),
  stat: statMock
}))

vi.mock('../native-chat/wsl-transcript-fs-access', async () => ({
  ...(await vi.importActual<typeof WslTranscriptFsAccess>(
    '../native-chat/wsl-transcript-fs-access'
  )),
  wslGatedStat: wslGatedStatMock
}))

const WSL_FILE = String.raw`\\wsl.localhost\Ubuntu\home\ada\.claude\projects\repo\session.jsonl`
const WSL_CONFIG = String.raw`\\wsl.localhost\Ubuntu\home\ada\.claude-alt`

const WSL_MISSING_FILE = WSL_FILE.replace('session.jsonl', 'missing.jsonl')

describe('scanClaudeUsageFiles WSL paths', () => {
  beforeEach(() => {
    vi.resetModules()
    listClaudeTranscriptFilesMock.mockReset().mockResolvedValue([WSL_FILE])
    readClaudeUsageScanFileMock.mockReset().mockResolvedValue({
      processedFile: { path: WSL_FILE, mtimeMs: 123, size: 10, lineCount: 1 },
      turns: []
    })
    statMock.mockReset().mockRejectedValue(new Error('native stat must not read WSL paths'))
    wslGatedStatMock.mockReset().mockResolvedValue({ mtimeMs: 123, size: 10 })
    buildWorktreeLookupMock.mockReset().mockResolvedValue(new Map())
    attributeClaudeUsageTurnsMock.mockReset().mockResolvedValue([])
    aggregateClaudeUsageMock.mockReset().mockReturnValue({ sessions: [], dailyAggregates: [] })
    finalizeClaudeSessionsMock.mockReset().mockReturnValue([])
    mergeClaudeDailyAggregatesMock.mockReset()
    mergeClaudeSessionsMock.mockReset()
  })

  it('uses the gated stat before deciding whether a WSL transcript can be reused', async () => {
    const { scanClaudeUsageFiles } = await import('./scanner')

    await expect(scanClaudeUsageFiles([])).resolves.toMatchObject({
      processedFiles: [{ path: WSL_FILE, mtimeMs: 123, size: 10 }]
    })

    expect(wslGatedStatMock).toHaveBeenCalledWith(WSL_FILE, 'scan')
    expect(statMock).not.toHaveBeenCalled()
  })

  it('continues scanning when one discovered WSL transcript cannot be statted', async () => {
    listClaudeTranscriptFilesMock.mockResolvedValue([WSL_MISSING_FILE, WSL_FILE])
    wslGatedStatMock.mockImplementation(async (filePath) => {
      if (filePath === WSL_MISSING_FILE) {
        throw new Error('WSL transcript disappeared')
      }
      return { mtimeMs: 123, size: 10 }
    })
    const { scanClaudeUsageFiles } = await import('./scanner')

    await expect(scanClaudeUsageFiles([])).resolves.toMatchObject({
      processedFiles: [{ path: WSL_FILE, mtimeMs: 123, size: 10 }]
    })
    expect(readClaudeUsageScanFileMock).toHaveBeenCalledWith(WSL_FILE)
    expect(readClaudeUsageScanFileMock).not.toHaveBeenCalledWith(WSL_MISSING_FILE)
  })

  it('passes the selected config directory to transcript discovery', async () => {
    const { scanClaudeUsageFiles } = await import('./scanner')

    await scanClaudeUsageFiles([], [], { configDir: WSL_CONFIG })

    expect(listClaudeTranscriptFilesMock).toHaveBeenCalledWith({ configDir: WSL_CONFIG })
  })
})
