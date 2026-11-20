import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import type * as FsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CodexHistoryCleanupMode } from '../cleanup-policy/codex-history-cleanup-policy'
import type { CodexHistoryCleanupSweepPolicy } from '../cleanup-policy/codex-history-cleanup-policy-live-update'
import { cleanUpCodexHistoryLeftBehind } from './codex-account-history-cleanup'
import { checkThenCleanUpCodexHistory } from './codex-account-history-cleanup-sweep'
import { checkCodexHistoryLeftBehind } from './codex-account-history-content-check'
import { shareCodexAccountHistory } from './codex-account-history-links'

// The platform's open-file check is its own concern (Linux always answers unknown); here nothing
// is open, so the proofs alone decide.
const openCheck = vi.hoisted(() => {
  const state: { onCheck: (() => void) | null } = { onCheck: null }
  return state
})
vi.mock('../../../filesystem/open-file-check', () => ({
  findOpenFiles: async () => {
    openCheck.onCheck?.()
    return new Set<string>()
  }
}))

vi.mock('../cleanup-policy/codex-history-cleanup-policy-live-update', () => ({
  codexHistoryCleanupSweepPolicy: async () => policy('report')
}))
vi.mock('../../../telemetry/codex-history-cleanup-telemetry', () => ({
  reportCodexHistoryCleanupOnce: async () => {}
}))

const busyPath = vi.hoisted(() => {
  const state: { value: string | null; attempts: number } = { value: null, attempts: 0 }
  return state
})
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  return {
    ...actual,
    unlink: async (path: string) => {
      if (path === busyPath.value) {
        busyPath.attempts += 1
        throw Object.assign(new Error('busy'), { code: 'EBUSY' })
      }
      return actual.unlink(path)
    }
  }
})

const SAME = 'rollout-2026-11-14T10-00-00-0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b.jsonl'
const TOUCHED = 'rollout-2026-11-14T11-00-00-0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c.jsonl'
const DIFFERENT = 'rollout-2026-11-14T12-00-00-0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5d.jsonl'
const DAY = join('2026', '11', '14')
const DAY_MS = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 10, 17)

function policy(mode: CodexHistoryCleanupMode): CodexHistoryCleanupSweepPolicy {
  return {
    revision: 1,
    rollouts: { mode, thresholds: { minSharedPasses: 1 } },
    databases: {
      mode,
      thresholds: {
        minSharedDays: 14,
        minSharedPasses: 5,
        maxSinceLastSharedDays: 30,
        minUnchangedDays: 14
      }
    },
    liveMode: () => mode
  }
}

const roots: string[] = []
const platform = process.platform
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  busyPath.value = null
  busyPath.attempts = 0
  openCheck.onCheck = null
  Object.defineProperty(process, 'platform', { value: platform })
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

// A home shared five times whose set-aside forms are checked: SAME matches the store, TOUCHED
// changed since its check, DIFFERENT never matched.
async function sharedHome() {
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
  for (const name of [
    'thread_history_1.sqlite',
    'thread_history_1.sqlite-wal',
    'memories_1.sqlite'
  ]) {
    utimesSync(join(account, name), NOW / 1000, NOW / 1000)
  }
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
  const cleanUp = (now: number, mode: CodexHistoryCleanupMode = 'enforce') =>
    cleanUpCodexHistoryLeftBehind({
      accountHome: account,
      storeHome: store,
      now,
      shouldStop: () => false,
      policy: policy(mode)
    })
  return { root, account, store, aside, share, cleanUp }
}

describe('cleanUpCodexHistoryLeftBehind', () => {
  it('deletes only proven copies, and the databases only after the home has worked shared', async () => {
    const { account, aside, share, cleanUp } = await sharedHome()

    expect((await cleanUp(NOW)).rollouts.deleted).toBe(1)
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
    expect((await cleanUp(NOW + 15 * DAY_MS)).databases.deleted).toBe(0)

    await at(NOW / 1000)
    expect((await cleanUp(NOW + 15 * DAY_MS)).databases.deleted).toBe(2)
    expect(existsSync(join(account, 'thread_history_1.sqlite'))).toBe(false)
    expect(existsSync(join(account, 'thread_history_1.sqlite-wal'))).toBe(false)
    // Codex can't rebuild memories from the rollouts.
    expect(existsSync(join(account, 'memories_1.sqlite'))).toBe(true)
  })

  it('in report mode deletes nothing but counts what enforce would delete', async () => {
    const { account, aside, cleanUp } = await sharedHome()

    const report = await cleanUp(NOW + 15 * DAY_MS, 'report')

    expect(report.rollouts).toMatchObject({ candidates: 2, eligible: 1, deleted: 1 })
    expect(report.rollouts.bytes).toBe(6)
    expect(report.databases).toMatchObject({ candidates: 2, eligible: 2, deleted: 2, bytes: 5 })
    expect(existsSync(join(aside, SAME))).toBe(true)
    expect(existsSync(join(account, 'thread_history_1.sqlite'))).toBe(true)
    expect(existsSync(join(account, 'thread_history_1.sqlite-wal'))).toBe(true)
  })

  it('reports a home once per policy revision, even when the budget cut its report short', async () => {
    const { root, account, store } = await sharedHome()
    // The open-file check outlasts the sweep's 10 s budget.
    openCheck.onCheck = () => vi.setSystemTime(NOW + 60_000)
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    vi.stubEnv('ORCA_USER_DATA_PATH', join(root, 'user-data'))
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const sweep = () =>
      checkThenCleanUpCodexHistory({
        accountHome: account,
        storeHome: store,
        shouldStop: () => false
      })

    expect(await sweep()).toBe(true)
    expect(info).toHaveBeenCalledTimes(1)
    expect(info.mock.calls[0][0]).toContain('budget reached')
    expect(await sweep()).toBe(true)
    expect(info).toHaveBeenCalledTimes(1)
  })

  it('keeps a copy for good after three busy unlinks', async () => {
    const { aside, cleanUp } = await sharedHome()
    Object.defineProperty(process, 'platform', { value: 'win32' })
    busyPath.value = join(aside, SAME)

    for (let run = 1; run <= 3; run += 1) {
      expect((await cleanUp(NOW)).rollouts.deleted).toBe(0)
      expect(busyPath.attempts).toBe(run)
    }
    busyPath.value = null

    expect((await cleanUp(NOW)).rollouts.deleted).toBe(0)
    expect(existsSync(join(aside, SAME))).toBe(true)
  })
})
