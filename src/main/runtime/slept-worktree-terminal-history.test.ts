import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import { hashWorktreeId } from '../terminal-history-paths'
import { flushPendingWorktreeHistoryDeletions } from '../terminal-history-deletion'
import { dropSleptWorktreeTerminalHistory } from './slept-worktree-terminal-history'

describe('dropSleptWorktreeTerminalHistory', () => {
  let userDataDir = ''

  afterEach(async () => {
    await flushPendingWorktreeHistoryDeletions()
    if (userDataDir) {
      rmSync(userDataDir, { recursive: true, force: true })
    }
  })

  it('drops that worktree terminal-history directory', async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'orca-sleep-history-'))
    installFakeAppEnvironment({ getPath: () => userDataDir })
    const worktreeId = 'repo-1::/path/slept-wt'
    const hash = hashWorktreeId(worktreeId)
    const historyDir = join(userDataDir, 'terminal-history', hash)
    mkdirSync(historyDir, { recursive: true })
    writeFileSync(join(historyDir, 'zsh_history'), 'echo slept\n')
    writeFileSync(
      join(historyDir, 'meta.json'),
      JSON.stringify({ worktreeId, createdAt: '2026-01-01T00:00:00.000Z' })
    )

    dropSleptWorktreeTerminalHistory(worktreeId, null)
    await flushPendingWorktreeHistoryDeletions()

    expect(existsSync(historyDir)).toBe(false)
    expect(readdirSync(join(userDataDir, 'terminal-history'))).not.toContain(hash)
  })
})
