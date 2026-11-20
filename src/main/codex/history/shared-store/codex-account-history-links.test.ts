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
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { zstdCompressSync } from 'node:zlib'
import { spawnProcess } from '@orca/process-host'
import { afterEach, describe, expect, it } from 'vitest'
import { shareCodexAccountHistory, unshareCodexAccountHistory } from './codex-account-history-links'

const ROLLOUT = 'rollout-2026-11-14T10-00-00-0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b.jsonl'
const OTHER = 'rollout-2026-11-14T11-00-00-0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c.jsonl'
const DAY = join('2026', '11', '14')

// Holds a thread lock the way Codex does: flock on macOS and Linux, LockFileEx on Windows.
async function holdThreadLock(lock: string): Promise<() => Promise<void>> {
  const windows = process.platform === 'win32'
  const holder = spawnProcess({
    program: windows ? 'powershell.exe' : '/usr/bin/perl',
    args: windows
      ? [
          '-NoProfile',
          '-Command',
          "$l = [IO.File]::Open($env:LOCK, 'OpenOrCreate', 'ReadWrite', 'ReadWrite, Delete'); $l.Lock(0, 1); [Console]::Out.WriteLine('locked'); [void][Console]::In.ReadLine()"
        ]
      : [
          '-MFcntl=:flock',
          '-e',
          'open(my $l, "+>>", $ARGV[0]) or die; flock($l, LOCK_EX) or die; $| = 1; print "locked\\n"; <STDIN>',
          lock
        ],
    env: { ...process.env, LOCK: lock },
    stdio: 'pipe'
  })
  const closed = new Promise((resolve) => holder.once('close', resolve))
  await createInterface({ input: holder.stdout })[Symbol.asyncIterator]().next()
  return async () => {
    holder.stdin.end()
    await closed
  }
}

const roots: string[] = []
function fixture(platform: NodeJS.Platform = 'linux') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'codex-account-history-')))
  roots.push(root)
  const store = join(root, 'store')
  const account = join(root, 'account')
  mkdirSync(join(store, 'sessions', DAY), { recursive: true })
  mkdirSync(join(account, 'sessions', DAY), { recursive: true })
  const pending = join(root, 'index-pending')
  const warnings: unknown[] = []
  const share = () =>
    shareCodexAccountHistory({
      accountHome: account,
      storeHome: store,
      sqliteHome: store,
      indexPendingDir: pending,
      platform,
      onWarning: (error) => warnings.push(error)
    })
  const unshare = () =>
    unshareCodexAccountHistory({
      accountHome: account,
      storeHome: store,
      onWarning: (error) => warnings.push(error)
    })
  return { store, account, pending, warnings, share, unshare }
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
    mkdirSync(join(f.account, 'memories'))
    writeFileSync(join(f.account, 'memories', 'note.md'), 'remember\n')
    mkdirSync(join(f.store, 'app-server-control'))
    mkdirSync(join(f.account, 'log'))

    expect(await f.share()).toBe('shared')

    expect(realpathSync(join(f.account, 'sessions'))).toBe(join(f.store, 'sessions'))
    expect(readFileSync(join(f.account, 'memories', 'note.md'), 'utf8')).toBe('remember\n')
    expect(realpathSync(join(f.account, 'memories'))).toBe(join(f.store, 'memories'))
    expect(readFileSync(join(f.store, 'sessions', DAY, ROLLOUT), 'utf8')).toBe('store version\n')
    expect(readFileSync(join(f.store, 'sessions', DAY, OTHER), 'utf8')).toBe('account only\n')
    expect(readFileSync(join(f.account, 'sessions.orca-profile-merge', DAY, ROLLOUT), 'utf8')).toBe(
      'account version\n'
    )
    expect(readdirSync(f.pending)).toEqual([OTHER])
    expect(readFileSync(join(f.account, 'config.toml'), 'utf8')).toBe(
      `sqlite_home = ${JSON.stringify(f.store)} # orca: Codex history shared across accounts\n`
    )
    expect(lstatSync(join(f.account, 'auth.json')).isFile()).toBe(true)
    expect(lstatSync(join(f.account, 'log')).isSymbolicLink()).toBe(false)
    expect(existsSync(join(f.account, 'app-server-control'))).toBe(false)
  })

  it('drops a hard-linked duplicate name but still owes the store its index row', async () => {
    const f = fixture()
    writeFileSync(join(f.store, 'sessions', DAY, ROLLOUT), 'same file\n')
    linkSync(join(f.store, 'sessions', DAY, ROLLOUT), join(f.account, 'sessions', DAY, ROLLOUT))

    await f.share()

    expect(readFileSync(join(f.store, 'sessions', DAY, ROLLOUT), 'utf8')).toBe('same file\n')
    expect(existsSync(join(f.account, 'sessions.orca-profile-merge'))).toBe(false)
    expect(readdirSync(f.pending)).toEqual([ROLLOUT])
    expect(f.warnings).toEqual([])
  })

  it('shares again after sharing was turned off and on, with earlier conflicts still kept', async () => {
    const f = fixture()
    writeFileSync(join(f.store, 'sessions', DAY, ROLLOUT), 'store version\n')
    writeFileSync(join(f.account, 'sessions', DAY, ROLLOUT), 'account version\n')
    await f.share()
    await f.unshare()
    mkdirSync(join(f.account, 'sessions', DAY), { recursive: true })
    writeFileSync(join(f.account, 'sessions', DAY, OTHER), 'private while off\n')

    expect(await f.share()).toBe('shared')

    expect(realpathSync(join(f.account, 'sessions'))).toBe(join(f.store, 'sessions'))
    expect(readFileSync(join(f.store, 'sessions', DAY, OTHER), 'utf8')).toBe('private while off\n')
    expect(readFileSync(join(f.account, 'sessions.orca-profile-merge', DAY, ROLLOUT), 'utf8')).toBe(
      'account version\n'
    )
  })

  it('keeps one form of a rollout in the store and sets the other aside', async () => {
    const f = fixture()
    const at = (path: string, seconds: number) => utimesSync(path, seconds, seconds)
    const compressed = zstdCompressSync(Buffer.from('plain\n'))
    const storeDay = join(f.store, 'sessions', DAY)
    const accountDay = join(f.account, 'sessions', DAY)
    writeFileSync(join(storeDay, `${ROLLOUT}.zst`), compressed)
    at(join(storeDay, `${ROLLOUT}.zst`), 1000)
    writeFileSync(join(accountDay, ROLLOUT), 'plain\n')
    at(join(accountDay, ROLLOUT), 1000)
    writeFileSync(join(storeDay, `${OTHER}.zst`), compressed)
    at(join(storeDay, `${OTHER}.zst`), 1000)
    writeFileSync(join(accountDay, OTHER), 'plain\nappended after compression\n')
    at(join(accountDay, OTHER), 2000)
    // A day the store lacks, holding both forms, merges file by file.
    const newDay = join(f.account, 'sessions', '2026', '11', '15')
    mkdirSync(newDay, { recursive: true })
    writeFileSync(join(newDay, ROLLOUT), 'plain\n')
    writeFileSync(join(newDay, `${ROLLOUT}.zst`), compressed)
    at(join(newDay, ROLLOUT), 1000)
    at(join(newDay, `${ROLLOUT}.zst`), 1000)
    writeFileSync(join(f.account, 'state_5.sqlite'), 'db')

    expect(await f.share()).toBe('shared')

    expect(readdirSync(storeDay).sort()).toEqual([`${ROLLOUT}.zst`, OTHER, `${OTHER}.zst`])
    expect(readdirSync(join(f.store, 'sessions', '2026', '11', '15'))).toEqual([`${ROLLOUT}.zst`])
    const setAside = join(f.account, '.orca-set-aside-rollouts', 'sessions', '2026', '11')
    expect(readdirSync(join(setAside, '14'))).toEqual([ROLLOUT])
    expect(readdirSync(join(setAside, '15'))).toEqual([ROLLOUT])
    const manifest = JSON.parse(readFileSync(join(f.account, '.orca-history-cleanup.json'), 'utf8'))
    expect(manifest).toMatchObject({
      version: 1,
      sharedPasses: 1,
      databases: [{ path: 'state_5.sqlite', bytes: 2 }]
    })
  })

  it('renames the ownership marker before a Windows home gets junctions', async () => {
    const f = fixture('win32')
    writeFileSync(join(f.account, '.orca-managed-home'), 'account-1\n')

    expect(await f.share()).toBe('shared')

    expect(existsSync(join(f.account, '.orca-managed-home'))).toBe(false)
    expect(readFileSync(join(f.account, '.orca-managed-home-linked'), 'utf8')).toBe('account-1\n')
  })

  it('links nothing into a Windows home without an ownership marker', async () => {
    const f = fixture('win32')

    expect(await f.share()).toBe('private')

    expect(lstatSync(join(f.account, 'sessions')).isSymbolicLink()).toBe(false)
  })

  it('waits while a Codex holds a thread lock, and shares once only a stale lock is left', async () => {
    const f = fixture()
    const lock = join(f.account, 'thread-writer-locks', '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c.lock')
    mkdirSync(join(f.account, 'thread-writer-locks'))
    writeFileSync(lock, '')
    writeFileSync(join(f.account, 'sessions', DAY, OTHER), 'account only\n')
    const release = await holdThreadLock(lock)

    try {
      expect(await f.share()).toBe('busy')
    } finally {
      await release()
    }
    expect(lstatSync(join(f.account, 'sessions')).isSymbolicLink()).toBe(false)

    expect(await f.share()).toBe('shared')
    expect(readFileSync(join(f.store, 'sessions', DAY, OTHER), 'utf8')).toBe('account only\n')
  })

  it('clears stale copies of one thread lock in both homes, so no two files can guard it', async () => {
    const f = fixture()
    const name = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c.lock'
    for (const home of [f.account, f.store]) {
      mkdirSync(join(home, 'thread-writer-locks'), { recursive: true })
      writeFileSync(join(home, 'thread-writer-locks', name), '')
    }

    expect(await f.share()).toBe('shared')

    expect(lstatSync(join(f.account, 'thread-writer-locks')).isSymbolicLink()).toBe(true)
    expect(existsSync(join(f.store, 'thread-writer-locks', name))).toBe(false)
  })

  it('keeps history apart while a thread lock the merge kept beside the store copy is held', async () => {
    const f = fixture()
    const kept = join(f.account, 'thread-writer-locks.orca-profile-merge')
    const lock = join(kept, '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c.lock')
    mkdirSync(join(f.store, 'thread-writer-locks'))
    symlinkSync(
      join(f.store, 'thread-writer-locks'),
      join(f.account, 'thread-writer-locks'),
      'junction'
    )
    mkdirSync(kept)
    writeFileSync(lock, '')
    const release = await holdThreadLock(lock)

    try {
      expect(await f.share()).toBe('busy')
    } finally {
      await release()
    }
    expect(lstatSync(join(f.account, 'sessions')).isSymbolicLink()).toBe(false)

    expect(await f.share()).toBe('shared')
    expect(existsSync(lock)).toBe(false)
  })
})

describe('unshareCodexAccountHistory', () => {
  it('gives the home fresh private folders and sets its old databases aside', async () => {
    const f = fixture()
    writeFileSync(join(f.account, 'sessions', DAY, OTHER), 'shared earlier\n')
    await f.share()
    writeFileSync(join(f.account, 'state_5.sqlite'), 'pre-share index')

    await f.unshare()

    expect(lstatSync(join(f.account, 'sessions')).isSymbolicLink()).toBe(false)
    expect(readdirSync(join(f.account, 'sessions'))).toEqual([])
    expect(readFileSync(join(f.account, 'config.toml'), 'utf8')).toBe('')
    expect(readFileSync(join(f.store, 'sessions', DAY, OTHER), 'utf8')).toBe('shared earlier\n')
    expect(existsSync(join(f.account, 'state_5.sqlite'))).toBe(false)
    const [held] = readdirSync(join(f.account, '.orca-pre-share-db'))
    expect(
      readFileSync(join(f.account, '.orca-pre-share-db', held, 'state_5.sqlite'), 'utf8')
    ).toBe('pre-share index')
  })
})
