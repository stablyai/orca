import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  isCodexAccountHistoryLinked,
  shareCodexAccountHistory,
  unshareCodexAccountHistory
} from './codex-account-history-links'
import { hostCodexHistoryStoreHome, wslCodexHistoryStoreHome } from './codex-history-store-home'
import { holdThreadLock } from './codex-thread-lock-holder.test-support'

const ROLLOUT = 'rollout-2026-11-14T10-00-00-0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b.jsonl'
const DAY = join('2026', '11', '14')

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'codex-history-store-')))
  roots.push(root)
  const account = join(root, 'account')
  const first = join(root, 'default-store')
  const second = join(root, 'history-folder')
  mkdirSync(join(account, 'sessions', DAY), { recursive: true })
  writeFileSync(join(account, 'sessions', DAY, ROLLOUT), 'written before sharing\n')
  const share = (store: string) =>
    shareCodexAccountHistory({
      accountHome: account,
      storeHome: store,
      sqliteHome: store,
      indexPendingDir: join(root, 'index-pending'),
      platform: 'linux',
      onWarning: () => {}
    })
  return { account, first, second, share }
}

describe('Codex history folder', () => {
  it('is the configured folder, else none for a distro whose folder is elsewhere', () => {
    expect(hostCodexHistoryStoreHome({ codexSessionSourceHome: { host: '/data/codex' } })).toBe(
      '/data/codex'
    )
    const wsl = {
      codexSessionSourceHome: { wsl: { Ubuntu: '\\\\wsl.localhost\\Ubuntu\\home\\u\\h' } }
    }
    expect(wslCodexHistoryStoreHome(wsl, 'ubuntu')).toBe('/home/u/h')
    expect(wslCodexHistoryStoreHome(wsl, 'Debian')).toBeNull()
  })

  it('moves an idle home to a new folder, leaving what the old one holds there', async () => {
    const { account, first, second, share } = fixture()
    expect(await share(first)).toBe('shared')

    expect(await share(second)).toBe('shared')

    expect(await isCodexAccountHistoryLinked(account, second)).toBe(true)
    expect(readFileSync(join(first, 'sessions', DAY, ROLLOUT), 'utf8')).toBe(
      'written before sharing\n'
    )
    expect(readFileSync(join(account, 'config.toml'), 'utf8')).toContain(second)
  })

  it('keeps a busy home on the old folder until its Codex lets go', async () => {
    const { account, first, second, share } = fixture()
    expect(await share(first)).toBe('shared')
    const release = await holdThreadLock(
      join(first, 'thread-writer-locks', '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b.lock')
    )

    try {
      expect(await share(second)).toBe('busy')
      expect(await isCodexAccountHistoryLinked(account, first)).toBe(true)
    } finally {
      await release()
    }
    expect(await share(second)).toBe('shared')
    expect(await isCodexAccountHistoryLinked(account, second)).toBe(true)
  })

  it('returns an idle home to the default when the folder is cleared, and unshares from either', async () => {
    const { account, first, second, share } = fixture()
    expect(await share(second)).toBe('shared')

    expect(await share(first)).toBe('shared')
    expect(await isCodexAccountHistoryLinked(account, first)).toBe(true)

    expect(await share(second)).toBe('shared')
    expect(
      await unshareCodexAccountHistory({
        accountHome: account,
        storeHome: first,
        onWarning: () => {}
      })
    ).toBe(true)
    expect(await isCodexAccountHistoryLinked(account, second)).toBe(false)
  })

  it('moves a home off a folder that is gone, and shares again after unsharing across a change', async () => {
    const { account, first, second, share } = fixture()
    expect(await share(first)).toBe('shared')
    rmSync(first, { recursive: true, force: true })

    expect(await share(second)).toBe('shared')
    expect(await isCodexAccountHistoryLinked(account, second)).toBe(true)

    mkdirSync(first)
    expect(
      await unshareCodexAccountHistory({
        accountHome: account,
        storeHome: first,
        onWarning: () => {}
      })
    ).toBe(true)
    expect(await share(first)).toBe('shared')
    expect(await isCodexAccountHistoryLinked(account, first)).toBe(true)
  })
})
