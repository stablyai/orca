import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanUpCodexHistoryLeftBehind } from './codex-account-history-cleanup'
import { checkCodexHistoryLeftBehind } from './codex-account-history-content-check'
import { shareCodexAccountHistory } from './codex-account-history-links'

const SAME = 'rollout-2026-11-14T10-00-00-0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b.jsonl'
const TOUCHED = 'rollout-2026-11-14T11-00-00-0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c.jsonl'
const DIFFERENT = 'rollout-2026-11-14T12-00-00-0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5d.jsonl'
const DAY = join('2026', '11', '14')
const DAY_MS = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 10, 17)

const roots: string[] = []
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})
afterEach(() => {
  vi.useRealTimers()
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('cleanUpCodexHistoryLeftBehind', () => {
  it('deletes only proven copies, and the databases only after the home has worked shared', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'codex-history-cleanup-')))
    roots.push(root)
    const store = join(root, 'store')
    const account = join(root, 'account')
    const storeDay = join(store, 'sessions', DAY)
    const accountDay = join(account, 'sessions', DAY)
    mkdirSync(storeDay, { recursive: true })
    mkdirSync(accountDay, { recursive: true })
    for (const [name, home] of [
      [SAME, 'plain\n'],
      [TOUCHED, 'plain\n'],
      [DIFFERENT, 'plain\nonly here\n']
    ]) {
      writeFileSync(join(storeDay, `${name}.zst`), zstdCompressSync(Buffer.from('plain\n')))
      utimesSync(join(storeDay, `${name}.zst`), 2000, 2000)
      writeFileSync(join(accountDay, name), home)
      utimesSync(join(accountDay, name), 1000, 1000)
    }
    writeFileSync(join(account, 'thread_history_1.sqlite'), 'db')
    writeFileSync(join(account, 'thread_history_1.sqlite-wal'), 'wal')
    writeFileSync(join(account, 'memories_1.sqlite'), 'only copy')
    const share = () =>
      shareCodexAccountHistory({
        accountHome: account,
        storeHome: store,
        sqliteHome: store,
        indexPendingDir: join(root, 'index-pending'),
        platform: 'linux',
        onWarning: () => {}
      })
    for (let pass = 0; pass < 5; pass += 1) {
      expect(await share()).toBe('shared')
    }
    const aside = join(account, '.orca-set-aside-rollouts', 'sessions', DAY)
    await checkCodexHistoryLeftBehind({
      accountHome: account,
      storeHome: store,
      shouldStop: () => false
    })
    utimesSync(join(aside, TOUCHED), 1500, 1500)
    const cleanUp = (now: number) =>
      cleanUpCodexHistoryLeftBehind({
        accountHome: account,
        storeHome: store,
        now,
        shouldStop: () => false
      })

    expect((await cleanUp(NOW)).deletedFiles).toBe(1)
    expect(existsSync(join(aside, SAME))).toBe(false)
    expect(existsSync(join(aside, TOUCHED))).toBe(true)
    expect(existsSync(join(aside, DIFFERENT))).toBe(true)
    expect(existsSync(join(account, 'thread_history_1.sqlite'))).toBe(true)

    // Written five days into sharing: something still opened it, so the database stays.
    const wal = join(account, 'thread_history_1.sqlite-wal')
    const at = (seconds: number) => {
      utimesSync(wal, seconds, seconds)
      return share()
    }
    await at((NOW + 5 * DAY_MS) / 1000)
    expect((await cleanUp(NOW + 15 * DAY_MS)).deletedFiles).toBe(0)

    await at(NOW / 1000)
    expect((await cleanUp(NOW + 15 * DAY_MS)).deletedFiles).toBe(2)
    expect(existsSync(join(account, 'thread_history_1.sqlite'))).toBe(false)
    expect(existsSync(join(account, 'thread_history_1.sqlite-wal'))).toBe(false)
    // Codex can't rebuild memories from the rollouts.
    expect(existsSync(join(account, 'memories_1.sqlite'))).toBe(true)
  })
})
