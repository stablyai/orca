import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type * as FsPromises from 'node:fs/promises'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { botMemoryHistoryFiles, createBotMemoryHistory } from './bot-memory-history'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  const readFile = vi.fn(actual.readFile)
  return { ...actual, default: { ...actual, readFile }, readFile }
})

const EARLIER = JSON.stringify([
  {
    id: 'row-1',
    at: Date.UTC(2026, 10, 1),
    by: { kind: 'owner' },
    change: { added: [{ line: '- Likes tea.', after: null }], removed: [] },
    undoable: true
  }
])

describe('memory history on disk', () => {
  let folder: string
  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'memory-history-'))
  })
  afterEach(() => {
    rmSync(folder, { recursive: true, force: true })
  })

  it.each([
    ['a read that fails', EARLIER, 'EIO'],
    ['a file it cannot parse', `${EARLIER.slice(0, -1)},{"id":`, null]
  ])('keeps earlier history when the next change meets %s', async (_, onDisk, code) => {
    const file = join(folder, 'bot-1.json')
    writeFileSync(file, onDisk)
    if (code) {
      vi.mocked(readFile).mockRejectedValueOnce(Object.assign(new Error(code), { code }))
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const history = createBotMemoryHistory(
      botMemoryHistoryFiles(() => folder),
      () => Date.UTC(2026, 10, 2)
    )

    await history.append(
      'bot-1',
      { kind: 'owner' },
      { added: [{ line: '- Owns a cat.', after: null }], removed: [] }
    )
    await history.settled()

    expect(readFileSync(file, 'utf8')).toBe(onDisk)
    warn.mockRestore()
  })
})
