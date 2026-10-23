import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HistoryReader } from '../../../daemon/history-reader'
import { getHistorySessionDirName } from '../../../daemon/history-paths'
import { seedSessionFromStoredScrollback } from './stored-scrollback-session-seed'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function historyDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-stored-scrollback-seed-'))
  roots.push(dir)
  return dir
}

const seed = (dir: string, scrollback = 'built ok\r\n$ ') => ({
  historyDir: dir,
  worktreeId: 'repo::/home/me/project',
  tabId: 'tab-1',
  leafId: 'leaf-1',
  ref: 'v1-00000000000000000000000000000001',
  scrollback,
  cwd: '/home/me/project'
})

describe('seedSessionFromStoredScrollback', () => {
  // Why through HistoryReader: it pins the legacy scrollback.bin restore this seed relies on.
  it('mints a session of the worktree that cold-restores the stored history', async () => {
    const dir = historyDir()
    const sessionId = seedSessionFromStoredScrollback(seed(dir))
    expect(sessionId.startsWith('repo::/home/me/project@@')).toBe(true)
    expect(await new HistoryReader(dir).detectColdRestoreState(sessionId)).toMatchObject({
      status: 'restored',
      restoreInfo: { scrollbackAnsi: 'built ok\r\n$ ', cwd: '/home/me/project' }
    })
  })

  it('redoes a seed a crash cut short before its meta.json landed', async () => {
    const dir = historyDir()
    const sessionId = seedSessionFromStoredScrollback(seed(dir))
    const sessionDir = join(dir, getHistorySessionDirName(sessionId))
    rmSync(join(sessionDir, 'meta.json'))
    writeFileSync(join(sessionDir, 'meta.json.tmp'), '{')
    expect(seedSessionFromStoredScrollback(seed(dir, 'again\r\n'))).toBe(sessionId)
    expect(existsSync(join(sessionDir, 'meta.json.tmp'))).toBe(false)
    expect(await new HistoryReader(dir).detectColdRestoreState(sessionId)).toMatchObject({
      restoreInfo: { scrollbackAnsi: 'again\r\n' }
    })
  })

  it('reuses the pane session on a later start instead of replaying the old snapshot', async () => {
    const dir = historyDir()
    const first = seedSessionFromStoredScrollback(seed(dir))
    // What the pane printed after its first start replaced the seeded history.
    writeFileSync(join(dir, getHistorySessionDirName(first), 'scrollback.bin'), 'newer output\r\n')
    const second = seedSessionFromStoredScrollback(seed(dir, 'stale snapshot\r\n'))
    expect(second).toBe(first)
    expect(await new HistoryReader(dir).detectColdRestoreState(second)).toMatchObject({
      restoreInfo: { scrollbackAnsi: 'newer output\r\n' }
    })
  })
})
