import type * as NodeFs from 'node:fs'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readCursor, writeCursor, writeKeptCopies } from './codex-account-copies-kept'
import { verifyCodexAccountCopies } from './codex-account-copies'
import { runCodexAccountCopiesRequest } from './codex-account-copies-requests'
import { TRASH_GRACE_MS } from './codex-account-copies-trash-entries'
import { recheckTrashedCopies } from './codex-account-copies-trash-recheck'
import { originalHoldsCopy } from './codex-account-copy-content'
import { HISTORY_CLEANUP_MANIFEST } from './codex-account-history-cleanup-manifest'

// Folders whose listing fails as on a failing disk.
const readdirFails = vi.hoisted(() => new Set<string>())
// Lets a test count directory listings, and make each cost time as on a slow or network disk.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  const readdirSync = vi.fn((...args: Parameters<typeof actual.readdirSync>) => {
    if (readdirFails.has(String(args[0]))) {
      throw Object.assign(new Error('EIO: i/o error, scandir'), { code: 'EIO' })
    }
    return actual.readdirSync(...args)
  })
  return { ...actual, readdirSync, default: { ...actual, readdirSync } }
})
const listingsOf = (path?: string): number =>
  vi.mocked(readdirSync).mock.calls.filter(([listed]) => path === undefined || listed === path)
    .length

const REL = '2026/11/20/rollout-2026-11-20T10-00-00-0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b.jsonl'
const LINE_1 = '{"type":"session_meta"}\n'
const LINE_2 = '{"type":"response_item","text":"second turn"}\n'

let root: string
let home: string
let store: string

function put(path: string, content: string | Buffer): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return path
}

const conflictCopy = (rel = REL): string => join(home, 'sessions.orca-profile-merge', rel)
const storeFile = (rel = REL): string => join(store, 'sessions', rel)
const otherThread = (n: number): string => REL.replace('0199a1b2', `0199a1b${n}`)

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-codex-copies-walk-'))
  home = join(root, 'codex-accounts', 'acct-1', 'home')
  store = join(root, 'codex')
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, '.orca-managed-home'), 'acct-1\n')
})

afterEach(() => {
  readdirFails.clear()
  rmSync(root, { recursive: true, force: true })
})

describe('originalHoldsCopy', () => {
  it('never trusts a saved offset past the copy, which would compare nothing', () => {
    const copy = put(conflictCopy(), 'abcd')
    const original = put(storeFile(), 'abce')

    expect(originalHoldsCopy(copy, original, 4n, { from: 9 })).toEqual({ holds: false })
  })
})

describe('verifyCodexAccountCopies', () => {
  it('resumes a copy too large for one launch where it stopped, after the smaller ones', async () => {
    const big = LINE_1.repeat(200)
    put(storeFile(), big)
    const bigCopy = put(conflictCopy(), big)
    put(storeFile(otherThread(3)), LINE_1)
    const small = put(conflictCopy(otherThread(3)), LINE_1)
    const verify = () =>
      verifyCodexAccountCopies({
        accountHome: home,
        storeHome: store,
        // Each launch has room for the small pair and under a third of the big one.
        budget: { maxBytes: 3_000, deadline: Date.now() + 60_000 },
        version: `test-${Math.random()}`,
        managedAccountsRoot: join(root, 'codex-accounts')
      })

    const launches = [await verify()]
    while (
      !launches.at(-1)?.verified.some((copy) => copy.copy === bigCopy) &&
      launches.length < 8
    ) {
      launches.push(await verify())
    }

    expect(launches[0].verified.map((copy) => copy.copy)).toEqual([small])
    expect(launches).toHaveLength(4)
  })
})

describe('copies a launch could not clear', () => {
  it(
    'reaches all 40,000 in turn when the first 5,000 never clear',
    async () => {
      const count = 40_000
      const day = '2026/11/20'
      mkdirSync(join(store, 'sessions', day), { recursive: true })
      mkdirSync(join(home, 'sessions.orca-profile-merge', day), { recursive: true })
      for (let i = 0; i < count; i += 1) {
        const name = `rollout-2026-11-20T10-00-00-0199a1b2-c3d4-7e5f-8a9b-${i.toString(16).padStart(12, '0')}.jsonl`
        writeFileSync(join(store, 'sessions', day, name), LINE_1)
        writeFileSync(join(home, 'sessions.orca-profile-merge', day, name), LINE_1)
      }
      const verify = () =>
        verifyCodexAccountCopies({
          accountHome: home,
          storeHome: store,
          budget: { maxBytes: 4 * 1024 ** 3, deadline: Date.now() + 600_000 },
          version: `test-${Math.random()}`,
          managedAccountsRoot: join(root, 'codex-accounts')
        })
      // Nothing is ever moved, as when every offered copy stays open: each launch offers 5,000.
      // The first 8 launches compare fresh copies; after that every one is a remembered retry.
      const offered = new Set<string>()
      const all = new Map<string, Awaited<ReturnType<typeof verify>>['verified'][number]>()
      const records: string[] = []
      for (let launch = 0; launch < 16; launch += 1) {
        for (const copy of (await verify()).verified) {
          all.set(copy.copy, copy)
          if (launch >= 8) {
            offered.add(copy.copy)
          }
        }
        records.push(readFileSync(join(home, '.orca-history-copies-kept.json'), 'utf8'))
      }
      expect(all.size).toBe(count)
      expect(offered.size).toBe(count)
      // Only the small cursor moves between retry launches; the kept-copies record isn't rewritten.
      expect(new Set(records.slice(8)).size).toBe(1)

      const locks = join(root, 'locks')
      mkdirSync(locks)
      await runCodexAccountCopiesRequest({
        op: 'trash',
        accountHome: home,
        copies: [...all.values()],
        lockFolders: [locks]
      })
      const ready = new Set<string>()
      for (let launch = 0; launch < 16; launch += 1) {
        const recheck = recheckTrashedCopies({
          accountHome: home,
          maxBytes: 4 * 1024 ** 3,
          deadline: Date.now() + 600_000,
          now: Date.now() + TRASH_GRACE_MS + 60_000
        })
        if (launch >= 8) {
          for (const copy of recheck.ready) {
            ready.add(copy.copy)
          }
        }
      }
      expect(ready.size).toBe(count)
    },
    // 80,000 real files and 32 launches over them: tens of seconds on CI disks.
    300_000
  )
})

describe('a launch cut short by its deadline', () => {
  it('reaches every copy over a few launches instead of starting over each time', async () => {
    const count = 2_000
    const day = '2026/11/20'
    mkdirSync(join(store, 'sessions', day), { recursive: true })
    mkdirSync(join(home, 'sessions.orca-profile-merge', day), { recursive: true })
    for (let i = 0; i < count; i += 1) {
      const name = `rollout-2026-11-20T10-00-00-0199a1b2-c3d4-7e5f-8a9b-${i.toString(16).padStart(12, '0')}.jsonl`
      writeFileSync(join(store, 'sessions', day, name), LINE_1)
      writeFileSync(join(home, 'sessions.orca-profile-merge', day, name), LINE_1)
    }
    // A clock that ticks once per read of it: each launch's deadline admits a few hundred copies.
    let tick = 0
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => (tick += 1))
    try {
      const offered = new Set<string>()
      for (let launch = 0; launch < 20; launch += 1) {
        const result = await verifyCodexAccountCopies({
          accountHome: home,
          storeHome: store,
          budget: { maxBytes: 4 * 1024 ** 3, deadline: tick + 600 },
          version: `test-${launch}`,
          managedAccountsRoot: join(root, 'codex-accounts')
        })
        for (const copy of result.verified) {
          offered.add(copy.copy)
        }
      }
      expect(offered.size).toBe(count)
    } finally {
      clock.mockRestore()
    }
  })
})

describe('a home on a slow disk', () => {
  it('spends each launch past where the last one stopped, not relisting every folder first', async () => {
    const folders = 200
    for (let f = 0; f < folders; f += 1) {
      for (let i = 0; i < 10; i += 1) {
        const id = (f * 10 + i).toString(16).padStart(12, '0')
        const rel = `2026/11/${String(f).padStart(3, '0')}/rollout-2026-11-20T10-00-00-0199a1b2-c3d4-7e5f-8a9b-${id}.jsonl`
        put(storeFile(rel), LINE_1)
        put(conflictCopy(rel), LINE_1)
      }
    }
    // Time passes only as the walk reads the clock or lists a folder, which costs five ticks.
    let tick = 0
    const before = listingsOf()
    const clock = vi
      .spyOn(Date, 'now')
      .mockImplementation(() => (tick += 1) + 5 * (listingsOf() - before))
    try {
      const offered = new Set<string>()
      for (let launch = 0; launch < 40; launch += 1) {
        const result = await verifyCodexAccountCopies({
          accountHome: home,
          storeHome: store,
          budget: { maxBytes: 4 * 1024 ** 3, deadline: Date.now() + 400 },
          version: `test-${launch}`,
          managedAccountsRoot: join(root, 'codex-accounts')
        })
        for (const copy of result.verified) {
          offered.add(copy.copy)
        }
      }
      expect(offered.size).toBe(folders * 10)
    } finally {
      clock.mockRestore()
    }
  })
})

describe('writeKeptCopies', () => {
  it('leaves an unchanged record alone whatever order its entries arrive in', () => {
    const file = join(home, '.orca-history-copies-kept.json')
    writeKeptCopies(home, { differs: { b: 'two', a: 'one' }, settled: null })
    const before = statSync(file, { bigint: true })

    writeKeptCopies(home, { differs: { a: 'one', b: 'two' }, settled: null })

    const after = statSync(file, { bigint: true })
    expect([after.ino, after.mtimeNs]).toEqual([before.ino, before.mtimeNs])
  })
})

describe('a launch that resumes mid-walk', () => {
  const verify = (version: string) =>
    verifyCodexAccountCopies({
      accountHome: home,
      storeHome: store,
      budget: { maxBytes: 4 * 1024 ** 3, deadline: Date.now() + 60_000 },
      version,
      managedAccountsRoot: join(root, 'codex-accounts')
    })

  it('lists the folder holding its cursor once, though the walk passes it twice', async () => {
    for (const n of [1, 2, 3]) {
      put(storeFile(otherThread(n)), LINE_1)
      put(conflictCopy(otherThread(n)), LINE_1)
    }
    writeCursor(home, { walkAfter: `sessions.orca-profile-merge/${otherThread(2)}` })
    const before = listingsOf(dirname(conflictCopy()))

    expect((await verify('test-wrap')).verified).toHaveLength(3)

    expect(listingsOf(dirname(conflictCopy())) - before).toBe(1)
  })

  it('serializes no kept-copies record when the launch learned nothing new', async () => {
    put(storeFile(), LINE_1 + LINE_2)
    put(conflictCopy(), LINE_1 + LINE_2.replace('second', 'secAnd'))
    await verify('test-1')
    const stringify = vi.spyOn(JSON, 'stringify')
    try {
      expect((await verify('test-2')).tally.differs).toBe(1)
      const records = stringify.mock.calls.filter(
        ([value]) => typeof value === 'object' && value !== null && 'differs' in value
      )
      expect(records).toHaveLength(0)
    } finally {
      stringify.mockRestore()
    }
  })
})

describe('a launch with nothing left of its budget', () => {
  it('still moves the first oversized copy along', async () => {
    const big = LINE_1.repeat(200)
    put(storeFile(), big)
    const copy = put(conflictCopy(), big)

    const { verified } = await verifyCodexAccountCopies({
      accountHome: home,
      storeHome: store,
      budget: { maxBytes: 1, deadline: Date.now() + 60_000 },
      version: 'test-oversized',
      managedAccountsRoot: join(root, 'codex-accounts')
    })

    expect(verified.map((item) => item.copy)).toEqual([copy])
  })

  it('gets past a run of empty folders a launch at a time, listing few per launch', async () => {
    for (let f = 0; f < 300; f += 1) {
      mkdirSync(
        join(home, 'sessions.orca-profile-merge', '2026', '11', String(f).padStart(3, '0')),
        {
          recursive: true
        }
      )
    }
    const rel = REL.replace('2026/11/20', '2026/11/300')
    put(storeFile(rel), LINE_1)
    const copy = put(conflictCopy(rel), LINE_1)
    // Each listing costs five ticks, as on a slow disk.
    let tick = 0
    const before = listingsOf()
    const clock = vi
      .spyOn(Date, 'now')
      .mockImplementation(() => (tick += 1) + 5 * (listingsOf() - before))
    const perLaunch: number[] = []
    let reached = false
    try {
      for (let launch = 0; launch < 40 && !reached; launch += 1) {
        const start = listingsOf()
        const result = await verifyCodexAccountCopies({
          accountHome: home,
          storeHome: store,
          budget: { maxBytes: 4 * 1024 ** 3, deadline: Date.now() + 100 },
          version: `test-empty-${launch}`,
          managedAccountsRoot: join(root, 'codex-accounts')
        })
        perLaunch.push(listingsOf() - start)
        reached = result.verified.some((item) => item.copy === copy)
      }
    } finally {
      clock.mockRestore()
    }

    expect(reached).toBe(true)
    expect(Math.max(...perLaunch)).toBeLessThan(40)
  })

  it('never settles a home whose walk the deadline stopped before a folder', async () => {
    writeFileSync(
      join(home, HISTORY_CLEANUP_MANIFEST),
      JSON.stringify({ firstSharedAt: '2026-11-20T00:00:00.000Z' })
    )
    put(storeFile(), LINE_1)
    const copy = put(conflictCopy(), LINE_1)
    const verify = (deadline: number) =>
      verifyCodexAccountCopies({
        accountHome: home,
        storeHome: store,
        budget: { maxBytes: 4 * 1024 ** 3, deadline },
        version: 'test-settled',
        managedAccountsRoot: join(root, 'codex-accounts')
      })

    expect((await verify(Date.now() - 1)).verified).toEqual([])

    expect((await verify(Date.now() + 60_000)).verified.map((item) => item.copy)).toEqual([copy])
  })

  it(
    'gives an oversized copy no slice once the launch has its 5,000',
    async () => {
      const day = '2026/11/20'
      const name = (i: number) =>
        `${day}/rollout-2026-11-20T10-00-00-0199a1b2-c3d4-7e5f-8a9b-${i.toString(16).padStart(12, '0')}.jsonl`
      const big = LINE_1.repeat(20_000)
      put(storeFile(name(0)), big)
      const bigCopy = put(conflictCopy(name(0)), big)
      for (let i = 1; i <= 5_001; i += 1) {
        put(storeFile(name(i)), LINE_1)
        put(conflictCopy(name(i)), LINE_1)
      }

      const { verified } = await verifyCodexAccountCopies({
        accountHome: home,
        storeHome: store,
        // Room for 5,000 small pairs, not the big one.
        budget: { maxBytes: 5_000 * (LINE_1.length * 2 + 1) + 100, deadline: Date.now() + 600_000 },
        version: 'test-full',
        managedAccountsRoot: join(root, 'codex-accounts')
      })

      expect(verified).toHaveLength(5_000)
      expect(verified.some((item) => item.copy === bigCopy)).toBe(false)
    },
    // 10,000 real files: several seconds on CI disks.
    120_000
  )
})

describe('a walk that meets trouble', () => {
  const verify = (deadline = Date.now() + 60_000) =>
    verifyCodexAccountCopies({
      accountHome: home,
      storeHome: store,
      budget: { maxBytes: 4 * 1024 ** 3, deadline },
      version: 'test-trouble',
      managedAccountsRoot: join(root, 'codex-accounts')
    })

  it('skips a folder it cannot list and still checks the rest', async () => {
    const later = REL.replace('2026/11/20', '2026/11/21')
    put(storeFile(), LINE_1)
    put(conflictCopy(), LINE_1)
    put(storeFile(later), LINE_1)
    const reached = put(conflictCopy(later), LINE_1)
    readdirFails.add(dirname(conflictCopy()))

    const result = await verify()

    expect(result.verified.map((item) => item.copy)).toEqual([reached])
    expect(result.tally.error).toBe(1)
  })

  it('still answers when the account home itself cannot be listed', async () => {
    put(storeFile(), LINE_1)
    put(conflictCopy(), LINE_1)
    readdirFails.add(home)

    expect((await verify()).tally.error).toBe(1)
  })

  it('keeps saved results only under a folder it cannot list, not for copies gone elsewhere', async () => {
    const later = REL.replace('2026/11/20', '2026/11/21')
    for (const rel of [REL, later]) {
      put(storeFile(rel), LINE_1)
      put(conflictCopy(rel), LINE_1)
    }
    await verify()
    readdirFails.add(dirname(conflictCopy()))
    rmSync(conflictCopy(later))

    await verifyCodexAccountCopies({
      accountHome: home,
      storeHome: store,
      budget: { maxBytes: 4 * 1024 ** 3, deadline: Date.now() + 60_000 },
      version: 'test-trouble-2',
      managedAccountsRoot: join(root, 'codex-accounts')
    })

    const record: unknown = JSON.parse(
      readFileSync(join(home, '.orca-history-copies-kept.json'), 'utf8')
    )
    const verified =
      record &&
      typeof record === 'object' &&
      'verified' in record &&
      record.verified &&
      typeof record.verified === 'object'
        ? record.verified
        : {}
    expect(Object.keys(verified)).toEqual([`sessions.orca-profile-merge/${REL}`])
  })

  it('keeps a deeper cursor when its time is up before reaching it', async () => {
    put(storeFile(), LINE_1)
    put(conflictCopy(), LINE_1)
    const walkAfter = `sessions.orca-profile-merge/${REL}`
    writeCursor(home, { walkAfter })

    await verify(Date.now() - 1)

    expect(readCursor(home).walkAfter).toBe(walkAfter)
  })
})
