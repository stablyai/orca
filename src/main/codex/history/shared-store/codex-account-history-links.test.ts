import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { shareCodexAccountHistory, unshareCodexAccountHistory } from './codex-account-history-links'

const ROLLOUT = 'rollout-2026-11-14T10-00-00-0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b.jsonl'
const OTHER = 'rollout-2026-11-14T11-00-00-0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c.jsonl'
const DAY = join('2026', '11', '14')

const roots: string[] = []
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'codex-account-history-')))
  roots.push(root)
  const store = join(root, 'store')
  const account = join(root, 'account')
  mkdirSync(join(store, 'sessions', DAY), { recursive: true })
  mkdirSync(join(account, 'sessions', DAY), { recursive: true })
  const warnings: unknown[] = []
  const share = () =>
    shareCodexAccountHistory({
      accountHome: account,
      storeHome: store,
      platform: 'linux',
      onWarning: (error) => warnings.push(error)
    })
  return { store, account, warnings, share }
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('shareCodexAccountHistory', () => {
  it('links history into the store, keeps the store copy of a conflict and the login private', async () => {
    const f = fixture()
    writeFileSync(join(f.store, 'sessions', DAY, ROLLOUT), 'store version\n')
    writeFileSync(join(f.account, 'sessions', DAY, ROLLOUT), 'account version\n')
    writeFileSync(join(f.account, 'sessions', DAY, OTHER), 'account only\n')
    writeFileSync(join(f.account, 'auth.json'), '{"account":"a"}')
    mkdirSync(join(f.store, 'memories'))
    mkdirSync(join(f.store, 'app-server-control'))
    mkdirSync(join(f.account, 'log'))

    expect(await f.share()).toBe('shared')

    expect(realpathSync(join(f.account, 'sessions'))).toBe(join(f.store, 'sessions'))
    expect(realpathSync(join(f.account, 'memories'))).toBe(join(f.store, 'memories'))
    expect(readFileSync(join(f.store, 'sessions', DAY, ROLLOUT), 'utf8')).toBe('store version\n')
    expect(readFileSync(join(f.store, 'sessions', DAY, OTHER), 'utf8')).toBe('account only\n')
    expect(readFileSync(join(f.account, 'sessions.orca-profile-merge', DAY, ROLLOUT), 'utf8')).toBe(
      'account version\n'
    )
    expect(readdirSync(join(f.account, '.orca-index-pending'))).toEqual([OTHER])
    expect(lstatSync(join(f.account, 'auth.json')).isFile()).toBe(true)
    expect(lstatSync(join(f.account, 'log')).isSymbolicLink()).toBe(false)
    expect(existsSync(join(f.account, 'app-server-control'))).toBe(false)
  })

  it('drops a hard-linked duplicate name without touching the shared file', async () => {
    const f = fixture()
    writeFileSync(join(f.store, 'sessions', DAY, ROLLOUT), 'same file\n')
    linkSync(join(f.store, 'sessions', DAY, ROLLOUT), join(f.account, 'sessions', DAY, ROLLOUT))

    await f.share()

    expect(readFileSync(join(f.store, 'sessions', DAY, ROLLOUT), 'utf8')).toBe('same file\n')
    expect(existsSync(join(f.account, 'sessions.orca-profile-merge'))).toBe(false)
    expect(f.warnings).toEqual([])
  })

  it('waits while a Codex in the home holds a thread lock', async () => {
    const f = fixture()
    mkdirSync(join(f.account, 'thread-writer-locks'))
    writeFileSync(join(f.account, 'thread-writer-locks', '0199a1b2.lock'), '')
    writeFileSync(join(f.account, 'sessions', DAY, OTHER), 'account only\n')

    expect(await f.share()).toBe('busy')

    expect(lstatSync(join(f.account, 'sessions')).isSymbolicLink()).toBe(false)
    expect(existsSync(join(f.store, 'sessions', DAY, OTHER))).toBe(false)
  })
})

describe('unshareCodexAccountHistory', () => {
  it('gives the home fresh private folders and sets its old databases aside', async () => {
    const f = fixture()
    writeFileSync(join(f.account, 'sessions', DAY, OTHER), 'shared earlier\n')
    await f.share()
    writeFileSync(join(f.account, 'state_5.sqlite'), 'pre-share index')

    await unshareCodexAccountHistory({
      accountHome: f.account,
      storeHome: f.store,
      onWarning: (error) => f.warnings.push(error)
    })

    expect(lstatSync(join(f.account, 'sessions')).isSymbolicLink()).toBe(false)
    expect(readdirSync(join(f.account, 'sessions'))).toEqual([])
    expect(readFileSync(join(f.store, 'sessions', DAY, OTHER), 'utf8')).toBe('shared earlier\n')
    expect(existsSync(join(f.account, 'state_5.sqlite'))).toBe(false)
    const [held] = readdirSync(join(f.account, '.orca-pre-share-db'))
    expect(
      readFileSync(join(f.account, '.orca-pre-share-db', held, 'state_5.sqlite'), 'utf8')
    ).toBe('pre-share index')
  })
})
