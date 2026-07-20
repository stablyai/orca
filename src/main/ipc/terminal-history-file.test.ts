import { describe, expect, it, vi } from 'vitest'
import { readTerminalHistoryFile } from './terminal-history-file'

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn()
}))

describe('readTerminalHistoryFile', () => {
  it('returns null for a shell with no HISTFILE support (e.g. fish)', async () => {
    const result = await readTerminalHistoryFile({
      worktreeId: 'w1',
      shellPath: '/usr/bin/fish'
    })
    expect(result).toBeNull()
  })
})
