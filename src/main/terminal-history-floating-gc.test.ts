import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installFakeAppEnvironment } from '../../config/scripts/vitest-host-ports-setup'

let userDataDir: string
let previousXdgDataHome: string | undefined

import { FLOATING_TERMINAL_WORKTREE_ID } from '../shared/constants'
import { fishHistorySessionName } from './fish-history-session'
import {
  cancelPendingHistoryTreeRemovalRetries,
  flushPendingWorktreeHistoryDeletions
} from './terminal-history-deletion'
import { runHistoryGc } from './terminal-history-gc'
import { hashWorktreeId } from './terminal-history-paths'

describe('floating terminal history GC', () => {
  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'orca-floating-history-gc-'))
    installFakeAppEnvironment({ getPath: () => userDataDir })
    previousXdgDataHome = process.env.XDG_DATA_HOME
    process.env.XDG_DATA_HOME = join(userDataDir, 'xdg')
  })

  afterEach(async () => {
    await flushPendingWorktreeHistoryDeletions()
    cancelPendingHistoryTreeRemovalRetries()
    if (previousXdgDataHome === undefined) {
      delete process.env.XDG_DATA_HOME
    } else {
      process.env.XDG_DATA_HOME = previousXdgDataHome
    }
    rmSync(userDataDir, { recursive: true, force: true })
  })

  function seedHistoryTree(root: string, worktreeId: string): string {
    const dir = join(root, hashWorktreeId(worktreeId))
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'meta.json'),
      JSON.stringify({
        worktreeId,
        createdAt: new Date(Date.now() - 10 * 60 * 1000).toISOString()
      })
    )
    return dir
  }

  it.each([
    ['native', ['terminal-history']],
    ['WSL', ['terminal-history-wsl', 'Ubuntu']]
  ])('preserves floating history and prunes true orphans under %s roots', async (_kind, parts) => {
    const historyRoot = join(userDataDir, ...parts)
    const floatingDir = seedHistoryTree(historyRoot, FLOATING_TERMINAL_WORKTREE_ID)
    const orphanDir = seedHistoryTree(historyRoot, 'dead-wt')

    await runHistoryGc(new Set(['live-wt']))
    await flushPendingWorktreeHistoryDeletions()

    expect(existsSync(floatingDir)).toBe(true)
    expect(existsSync(orphanDir)).toBe(false)
  })

  it('preserves aged floating fish history while sweeping true orphans', async () => {
    const fishDir = join(process.env.XDG_DATA_HOME!, 'fish')
    const floatingFile = join(
      fishDir,
      `${fishHistorySessionName(hashWorktreeId(FLOATING_TERMINAL_WORKTREE_ID))}_history`
    )
    const orphanFile = join(fishDir, `${fishHistorySessionName(hashWorktreeId('dead-wt'))}_history`)
    mkdirSync(fishDir, { recursive: true })
    writeFileSync(floatingFile, 'floating\n')
    writeFileSync(orphanFile, 'orphan\n')
    const old = new Date(Date.now() - 10 * 60 * 1000)
    utimesSync(floatingFile, old, old)
    utimesSync(orphanFile, old, old)

    await runHistoryGc(new Set(['live-wt']))

    expect(existsSync(floatingFile)).toBe(true)
    expect(existsSync(orphanFile)).toBe(false)
  })
})
