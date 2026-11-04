import { mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const access = vi.hoisted(() => ({
  path: '',
  open: vi.fn(),
  read: vi.fn(),
  close: vi.fn(),
  stat: vi.fn(),
  handleStat: vi.fn()
}))
vi.mock('../native-chat/wsl-transcript-fs-access', () => ({
  WSL_TRANSCRIPT_READ_CHUNK_BYTES: 1024 * 1024,
  openTranscriptFile: access.open,
  readTranscriptFile: access.read,
  closeTranscriptHandle: access.close
}))
vi.mock('../native-chat/wsl-transcript-fs-snapshot', () => ({
  wslGatedBigIntStat: access.stat,
  wslGatedHandleStat: access.handleStat
}))
vi.mock('./transcript-file-discovery', () => ({
  listClaudeTranscriptFiles: async () => [access.path]
}))

const WSL_FILE = String.raw`\\wsl.localhost\Ubuntu\home\ada\.claude\projects\repo\session.jsonl`

describe('WSL usage with snapshot checkpoints', () => {
  let root: string
  let source: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-wsl-usage-'))
    source = join(root, 'session.jsonl')
    access.path = WSL_FILE
    access.open.mockImplementation(() => open(source, 'r'))
    access.read.mockImplementation((handle, _path, buffer, offset, length, position) =>
      handle.read(buffer, offset, length, position)
    )
    access.close.mockImplementation((handle) => handle.close())
    access.stat.mockImplementation(() => stat(source, { bigint: true }))
    access.handleStat.mockImplementation((handle) => handle.stat({ bigint: true }))
  })
  afterEach(async () => {
    vi.clearAllMocks()
    await rm(root, { recursive: true, force: true })
  })
  const row = (id: string) =>
    `${JSON.stringify({
      type: 'assistant',
      sessionId: 'session',
      timestamp: '2026-10-10T12:00:00Z',
      message: { id, model: 'claude-sonnet-4-6', usage: { input_tokens: 10, output_tokens: 2 } },
      padding: 'x'.repeat(14000)
    })}\n`

  it('reads a pinned WSL handle and resumes only the appended suffix', async () => {
    const { readClaudeUsageScanFile } = await import('./transcript-record-parser')
    await writeFile(source, row('first'))
    const first = await readClaudeUsageScanFile(WSL_FILE)
    expect(first.turns).toHaveLength(1)
    expect(first.checkpoint?.physicalFileId).toBeTruthy()
    expect(access.open).toHaveBeenCalledWith(WSL_FILE, 'scan')
    expect(access.handleStat).toHaveBeenCalled()
    expect(access.close).toHaveBeenCalledTimes(1)
    if (!first.checkpoint) {
      throw new Error('Expected a resumable checkpoint')
    }
    await writeFile(source, (await readFile(source, 'utf8')) + row('second'))
    const second = await readClaudeUsageScanFile(WSL_FILE, {
      ...first.checkpoint,
      lineCount: first.committedLineCount,
      ownedTokenMaxima: [],
      projections: [],
      encounterOrder: []
    })
    expect(second.resumed).toBe(true)
    expect(second.turns).toHaveLength(1)
    expect(second.turns[0].dedupeKey).toBe('msg:second')
    expect(access.close).toHaveBeenCalledTimes(2)
  })
  it('does not turn an unavailable WSL snapshot into empty usage', async () => {
    const { scanClaudeUsageFiles } = await import('./scanner')
    access.stat.mockRejectedValueOnce(new Error('WSL temporarily unavailable'))
    await expect(scanClaudeUsageFiles([])).rejects.toThrow('WSL temporarily unavailable')
  })
})
