import type * as NodeFs from 'node:fs'
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeCursor, writeKeptCopies } from './codex-account-copies-kept'
import { cleanUpCodexAccountCopies } from './codex-account-copies-cleanup'
import { verifyCodexAccountCopies } from './codex-account-copies'
import { runCodexAccountCopiesRequest } from './codex-account-copies-requests'
import { moveCheckedCopiesToTrash } from './codex-account-copies-trash'
import { listFiles, readList, TRASH_GRACE_MS } from './codex-account-copies-trash-entries'
import { originalHoldsCopy } from './codex-account-copy-content'
import { recheckTrashedCopies } from './codex-account-copies-trash-recheck'
import type { CodexHistoryMoveOutcome } from '../../../telemetry/codex-history-move-telemetry'

// Paths whose lstat fails as on a failing disk.
const lstatFails = vi.hoisted(() => new Set<string>())
// Lets a test count directory listings, and make each cost time as on a slow or network disk.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  const readdirSync = vi.fn(actual.readdirSync)
  function lstatSync(...args: Parameters<typeof actual.lstatSync>) {
    if (lstatFails.has(String(args[0]))) {
      throw Object.assign(new Error('EIO: i/o error, lstat'), { code: 'EIO' })
    }
    return actual.lstatSync(...args)
  }
  return { ...actual, readdirSync, lstatSync, default: { ...actual, readdirSync, lstatSync } }
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

function run(
  options: {
    outcome?: CodexHistoryMoveOutcome
    open?: (paths: string[]) => Set<string> | null
    beforeMove?: () => void
    /** False: Codex's lock coordination can't be taken. */
    locks?: boolean
    /** Copies carrying an ACL entry. */
    acl?: (paths: string[]) => Set<string> | null
    /** Moves never answer, as on a hung mount; `events` records the order of steps. */
    hangMove?: boolean
    /** The open check never answers, as on a stalled volume. */
    hangOpen?: boolean
    /** Moves happen, but their answer never arrives: a move that lands after the locks went. */
    lateMove?: boolean
    /** This step outside the locks never answers. */
    hang?: string
    events?: string[]
  } = {}
) {
  return cleanUpCodexAccountCopies({
    homes: [home],
    storeHome: store,
    platform: 'darwin',
    managedAccountsRoot: join(root, 'codex-accounts'),
    version: `test-${Math.random()}`,
    moveOutcome: () => options.outcome ?? 'moved',
    shouldStop: () => false,
    findOpen: async (paths) =>
      options.hangOpen
        ? new Promise<never>(() => {})
        : options.open
          ? options.open(paths)
          : new Set(),
    findAcl: async (paths) => (options.acl ? options.acl([...paths]) : new Set()),
    holdLocks: async () => {
      if (options.locks === false) {
        return null
      }
      options.events?.push('hold')
      return {
        stillHeld: () => true,
        release: async () => {
          options.events?.push('release')
        }
      }
    },
    lockHoldMs: 50,
    stepWaitMs: options.hang ? 20 : undefined,
    worker: {
      call: async (request) => {
        options.events?.push(request.op)
        if (options.hang === request.op) {
          return new Promise<never>(() => {})
        }
        if (request.op === 'trash') {
          options.beforeMove?.()
          if (options.hangMove) {
            return new Promise<never>(() => {})
          }
          if (options.lateMove) {
            await runCodexAccountCopiesRequest(request)
            return new Promise<never>(() => {})
          }
        }
        return runCodexAccountCopiesRequest(request).catch((error: unknown) => ({
          ok: false as const,
          message: String(error)
        }))
      },
      stop: async () => {
        options.events?.push('stop')
      }
    }
  })
}

const trashDir = (): string => join(home, '.orca-copies-trash.orca-profile-merge')

function trashed(): string[] {
  if (!existsSync(trashDir())) {
    return []
  }
  return readdirSync(trashDir())
    .filter((name) => name.includes('rollout-'))
    .map((name) => join(trashDir(), name))
}

/** A launch once the grace period has passed. */
async function afterGrace(options: Parameters<typeof run>[0] = {}) {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.now() + TRASH_GRACE_MS + 60_000)
  try {
    return await run(options)
  } finally {
    vi.useRealTimers()
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-codex-copies-'))
  home = join(root, 'codex-accounts', 'acct-1', 'home')
  store = join(root, 'codex')
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, '.orca-managed-home'), 'acct-1\n')
})

afterEach(() => {
  lstatFails.clear()
  rmSync(root, { recursive: true, force: true })
})

describe('cleanUpCodexAccountCopies', () => {
  it('trashes a copy identical to or a prefix of its original, keeps one with bytes it lacks', async () => {
    put(storeFile(), LINE_1 + LINE_2)
    const prefix = put(conflictCopy(), LINE_1)
    put(storeFile(otherThread(3)), LINE_1 + LINE_2)
    const identical = put(conflictCopy(otherThread(3)), LINE_1 + LINE_2)
    // Same size, one byte different: only reading both shows it.
    put(storeFile(otherThread(4)), LINE_1 + LINE_2)
    const differs = put(conflictCopy(otherThread(4)), LINE_1 + LINE_2.replace('second', 'secAnd'))
    // The copy has a turn ~/.codex never got.
    put(storeFile(otherThread(5)), LINE_1)
    const longer = put(conflictCopy(otherThread(5)), LINE_1 + LINE_2)
    const orphan = put(conflictCopy(otherThread(6)), LINE_1)

    const tally = await run()

    expect(existsSync(prefix)).toBe(false)
    expect(existsSync(identical)).toBe(false)
    expect(existsSync(differs)).toBe(true)
    expect(existsSync(longer)).toBe(true)
    expect(existsSync(orphan)).toBe(true)
    expect(tally).toMatchObject({ trashed: 2, deleted: 0, differs: 2, missing_original: 1 })
    expect(trashed()).toHaveLength(2)
    expect(existsSync(storeFile())).toBe(true)
  })

  it('keeps a copy whose thread a Codex has open to append, before it writes anything', async () => {
    put(storeFile(), LINE_1)
    const copy = put(conflictCopy(), LINE_1)
    // Held: with coordination held, a lock file still there belongs to a live Codex.
    put(join(store, 'thread-writer-locks', '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b.lock'), '')

    expect(await run()).toMatchObject({ trashed: 0, busy: 1 })
    expect(existsSync(copy)).toBe(true)
  })

  it('keeps every copy when Codex lock coordination cannot be held', async () => {
    put(storeFile(), LINE_1)
    const copy = put(conflictCopy(), LINE_1)

    await run({ locks: false })

    expect(existsSync(copy)).toBe(true)
  })

  it('keeps a copy whose original was truncated after the check', async () => {
    put(storeFile(), LINE_1 + LINE_2)
    const copy = put(conflictCopy(), LINE_1 + LINE_2)

    await run({ beforeMove: () => writeFileSync(storeFile(), LINE_1.slice(0, 4)) })

    expect(existsSync(copy)).toBe(true)
  })

  it('keeps a plain copy against a cut-off compressed original, and never decodes one', async () => {
    const setAside = (rel: string) => join(home, '.orca-set-aside-rollouts', 'sessions', rel)
    const whole = zstdCompressSync(Buffer.from(LINE_1 + LINE_2))
    // The checksum cut off: every declared byte still decodes.
    put(`${storeFile()}.zst`, whole.subarray(0, -4))
    const readable = put(setAside(REL), LINE_1)
    put(`${storeFile(otherThread(3))}.zst`, whole)
    const twin = put(conflictCopy(otherThread(3)), LINE_1)
    // A `.zst` copy against a plain original: its later frames could hold anything.
    put(storeFile(otherThread(4)), LINE_1)
    const frames = put(
      `${conflictCopy(otherThread(4))}.zst`,
      Buffer.concat([zstdCompressSync(Buffer.from(LINE_1)), zstdCompressSync(Buffer.from(LINE_2))])
    )
    // Identical compressed bytes are the one `.zst` case that goes.
    put(`${storeFile(otherThread(5))}.zst`, whole)
    const sameZst = put(`${conflictCopy(otherThread(5))}.zst`, whole)

    const tally = await run()

    expect(existsSync(readable)).toBe(true)
    expect(existsSync(twin)).toBe(true)
    expect(existsSync(frames)).toBe(true)
    expect(existsSync(sameZst)).toBe(false)
    expect(tally).toMatchObject({ compressed: 3, trashed: 1 })
  })

  it.skipIf(process.platform === 'win32')(
    'keeps a copy another user could write, which no open check can see them hold',
    async () => {
      put(storeFile(), LINE_1)
      const copy = put(conflictCopy(), LINE_1)
      chmodSync(copy, 0o666)

      await run()

      expect(existsSync(copy)).toBe(true)
    }
  )

  it('keeps a copy with an ACL entry, or when ACLs cannot be read', async () => {
    put(storeFile(), LINE_1)
    const copy = put(conflictCopy(), LINE_1)

    await run({ acl: (paths) => new Set(paths) })
    expect(existsSync(copy)).toBe(true)
    await run({ acl: () => null })
    expect(existsSync(copy)).toBe(true)
  })

  it('does not read or offer a copy kept for an ACL again until it changes', async () => {
    put(storeFile(), LINE_1 + LINE_2)
    const copy = put(conflictCopy(), LINE_1)
    const asked: string[] = []
    const acl = (paths: string[]) => {
      asked.push(...paths)
      return new Set(paths)
    }

    await run({ acl })
    await run({ acl })
    expect(asked).toEqual([copy])
    appendFileSync(copy, LINE_2)
    await run({ acl })

    expect(asked).toEqual([copy, copy])
    expect(existsSync(copy)).toBe(true)
  })

  it('lets go of the locks on time when a move is stuck, without waiting for it', async () => {
    put(storeFile(), LINE_1)
    const copy = put(conflictCopy(), LINE_1)
    const events: string[] = []

    expect(await run({ hangMove: true, events })).toBeNull()

    expect(events.slice(events.indexOf('trash'))).toEqual(['trash', 'stop', 'release'])
    expect(existsSync(copy)).toBe(true)
  })

  it('lets go of the locks on time when the open check stalls under them', async () => {
    put(storeFile(), LINE_1)
    const copy = put(conflictCopy(), LINE_1)
    const events: string[] = []

    expect(await run({ hangOpen: true, events })).toBeNull()

    expect(events.slice(events.indexOf('hold'))).toEqual(['hold', 'stop', 'release'])
    expect(existsSync(copy)).toBe(true)
  })

  it('checks ACLs before taking the locks', async () => {
    put(storeFile(), LINE_1)
    put(conflictCopy(), LINE_1)
    const events: string[] = []

    await run({ acl: (paths) => new Set(paths), events })

    expect(events).toContain('remember-acl')
    expect(events).not.toContain('hold')
  })

  it.skipIf(process.platform === 'win32')(
    'keeps a copy whose folder became a link after its check',
    async () => {
      put(storeFile(), LINE_1)
      const copy = put(conflictCopy(), LINE_1)
      const folder = dirname(copy)
      const moved = join(root, 'moved')

      // The same file through a link: only the link checks tell the move would go elsewhere.
      await run({
        beforeMove: () => {
          renameSync(folder, moved)
          symlinkSync(moved, folder)
        }
      })

      expect(existsSync(join(moved, basename(copy)))).toBe(true)
    }
  )

  it('keeps a copy a process has open, or when that cannot be told', async () => {
    put(storeFile(), LINE_1)
    const copy = put(conflictCopy(), LINE_1)

    await run({ open: (paths) => new Set(paths) })
    expect(existsSync(copy)).toBe(true)
    await run({ open: () => null })
    expect(existsSync(copy)).toBe(true)
  })

  it('keeps every copy of a home whose move is stuck', async () => {
    put(storeFile(), LINE_1)
    const copy = put(conflictCopy(), LINE_1)

    for (const outcome of ['busy', 'refused', 'incomplete', 'failed'] as const) {
      await run({ outcome })
    }
    expect(existsSync(copy)).toBe(true)
  })

  it('keeps a copy written to after its check', async () => {
    put(storeFile(), LINE_1 + LINE_2)
    const copy = put(conflictCopy(), LINE_1)

    await run({ beforeMove: () => appendFileSync(copy, LINE_2.replace('second', 'other')) })

    expect(existsSync(copy)).toBe(true)
  })

  it('touches nothing in a folder that is not an Orca account home', async () => {
    rmSync(join(home, '.orca-managed-home'))
    put(storeFile(), LINE_1)
    const copy = put(conflictCopy(), LINE_1)

    await run()

    expect(existsSync(copy)).toBe(true)
  })

  it('never follows a link out of the home', async () => {
    put(storeFile(), LINE_1)
    const elsewhere = join(root, 'backup')
    const backupCopy = put(join(elsewhere, REL), LINE_1)
    symlinkSync(elsewhere, join(home, 'sessions.orca-profile-merge'), 'junction')

    await run()

    expect(existsSync(backupCopy)).toBe(true)
  })
})

describe('trashed copies', () => {
  it('deletes a trashed copy only after its grace period, while its original still holds it', async () => {
    put(storeFile(), LINE_1 + LINE_2)
    put(conflictCopy(), LINE_1)

    expect(await run()).toMatchObject({ trashed: 1 })
    expect(await run()).toMatchObject({ deleted: 0 })
    expect(trashed()).toHaveLength(1)
    expect(await afterGrace()).toMatchObject({ deleted: 1, restored: 0 })

    expect(existsSync(trashDir())).toBe(false)
    expect(readFileSync(storeFile(), 'utf8')).toBe(LINE_1 + LINE_2)
  })

  it('puts a copy back when its original was truncated while it waited', async () => {
    put(storeFile(), LINE_1 + LINE_2)
    const copy = put(conflictCopy(), LINE_1 + LINE_2)
    await run()

    writeFileSync(storeFile(), LINE_1.slice(0, 4))

    expect(await afterGrace()).toMatchObject({ deleted: 0, restored: 1 })
    expect(readFileSync(copy, 'utf8')).toBe(LINE_1 + LINE_2)
  })

  it('never puts a copy back over a file that took its place', async () => {
    put(storeFile(), LINE_1 + LINE_2)
    const copy = put(conflictCopy(), LINE_1 + LINE_2)
    await run()

    writeFileSync(storeFile(), LINE_1.slice(0, 4))
    put(copy, 'newer')

    expect(await afterGrace()).toMatchObject({ deleted: 0, restored: 0 })
    expect(readFileSync(copy, 'utf8')).toBe('newer')
    expect(trashed().map((path) => readFileSync(path, 'utf8'))).toEqual([LINE_1 + LINE_2])
  })

  it('puts a copy back when Codex compressed its original meanwhile, never decoding it', async () => {
    put(storeFile(), LINE_1)
    const copy = put(conflictCopy(), LINE_1)
    await run()

    put(`${storeFile()}.zst`, zstdCompressSync(Buffer.from(LINE_1)))
    rmSync(storeFile())

    // Counted twice: by the recheck, then by this launch's verify of the restored copy.
    expect(await afterGrace()).toMatchObject({ deleted: 0, restored: 1, compressed: 2 })
    expect(readFileSync(copy, 'utf8')).toBe(LINE_1)
  })

  it('puts a copy back when a writer that had it open wrote to it in the trash', async () => {
    put(storeFile(), LINE_1)
    const copy = put(conflictCopy(), LINE_1)
    await run()

    appendFileSync(trashed()[0], LINE_2)

    expect(await afterGrace()).toMatchObject({ deleted: 0, restored: 1 })
    expect(readFileSync(copy, 'utf8')).toBe(LINE_1 + LINE_2)
  })

  it('keeps a trashed copy a process has open, or when that cannot be told', async () => {
    put(storeFile(), LINE_1)
    put(conflictCopy(), LINE_1)
    await run()

    await afterGrace({ open: (paths) => new Set(paths) })
    await afterGrace({ open: () => null })

    expect(trashed()).toHaveLength(1)
  })

  it.skipIf(process.platform === 'win32')(
    'puts back a trashed copy another user could write, which no open check can see them hold',
    async () => {
      put(storeFile(), LINE_1)
      const copy = put(conflictCopy(), LINE_1)
      await run()

      chmodSync(trashed()[0], 0o666)

      expect(await afterGrace()).toMatchObject({ deleted: 0, restored: 1 })
      expect(existsSync(copy)).toBe(true)
    }
  )

  it('checks a move that landed after the locks were let go before deleting it', async () => {
    put(storeFile(), LINE_1 + LINE_2)
    const copy = put(conflictCopy(), LINE_1 + LINE_2)

    expect(await run({ lateMove: true })).toBeNull()
    expect(trashed()).toHaveLength(1)
    writeFileSync(storeFile(), LINE_1)

    expect(await afterGrace()).toMatchObject({ deleted: 0, restored: 1 })
    expect(readFileSync(copy, 'utf8')).toBe(LINE_1 + LINE_2)
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
      for (let launch = 0; launch < 30; launch += 1) {
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

describe('a step that never answers', () => {
  it('abandons the run and deletes nothing when a delete outside the locks hangs', async () => {
    put(storeFile(), LINE_1)
    put(conflictCopy(), LINE_1)
    await run()
    const events: string[] = []

    expect(await afterGrace({ hang: 'delete-trashed', events })).toBeNull()

    expect(events.slice(events.indexOf('delete-trashed'))).toEqual(['delete-trashed', 'stop'])
    expect(trashed()).toHaveLength(1)
  })
})

describe('trash bookkeeping', () => {
  it('never trusts a saved offset past the copy, which would compare nothing', () => {
    const copy = put(conflictCopy(), 'abcd')
    const original = put(storeFile(), 'abce')

    expect(originalHoldsCopy(copy, original, 4n, { from: 9 })).toEqual({ holds: false })
  })

  it('keeps going through a list when one trashed copy cannot be looked at', async () => {
    put(storeFile(), LINE_1)
    put(conflictCopy(), LINE_1)
    put(storeFile(otherThread(3)), LINE_1)
    put(conflictCopy(otherThread(3)), LINE_1)
    await run()
    const [failing] = trashed()
    lstatFails.add(failing)

    expect(await afterGrace()).toMatchObject({ deleted: 1 })

    expect(trashed()).toEqual([failing])
    lstatFails.clear()
    expect(await afterGrace()).toMatchObject({ deleted: 1 })
  })

  it('saves recheck progress when only the original key moved on', async () => {
    const big = LINE_1.repeat(200)
    put(storeFile(), big)
    put(conflictCopy(), big)
    await run()
    const trash = trashDir()
    const recheck = () =>
      recheckTrashedCopies({
        accountHome: home,
        maxBytes: 1_001,
        deadline: Date.now() + 60_000,
        now: Date.now() + TRASH_GRACE_MS + 60_000
      })
    const matched = () => readList(trash, listFiles(trash)[0].name)?.[0].progress?.matched

    recheck()
    expect(matched()).toBe(500)
    appendFileSync(storeFile(), LINE_2)
    recheck()
    recheck()

    expect(matched()).toBe(1_000)
  })

  it('gives copies moved in the same millisecond under one name their own trash names', async () => {
    const days = ['2026/11/20', '2026/11/21']
    for (const day of days) {
      put(storeFile(REL.replace('2026/11/20', day)), LINE_1)
      put(conflictCopy(REL.replace('2026/11/20', day)), LINE_1)
    }
    const { verified } = await verifyCodexAccountCopies({
      accountHome: home,
      storeHome: store,
      budget: { maxBytes: 4 * 1024 ** 3, deadline: Date.now() + 60_000 },
      version: 'test-names',
      managedAccountsRoot: join(root, 'codex-accounts')
    })
    const locks = join(root, 'locks')
    mkdirSync(locks)

    const tallies = verified.map((copy) => moveCheckedCopiesToTrash(home, [copy], [locks], 1_000))

    expect(tallies.map((tally) => tally.trashed)).toEqual([1, 1])
    expect(trashed()).toHaveLength(2)
  })

  it('never deletes a trashed copy rewritten in place after its recheck, times put back', async () => {
    put(storeFile(), LINE_1)
    const copy = put(conflictCopy(), LINE_1)
    utimesSync(copy, 1_700_000_000, 1_700_000_000)
    await run()
    // The recheck passes, but the copy is open, so it waits.
    await afterGrace({ open: (paths) => new Set(paths) })
    const [inTrash] = trashed()

    writeFileSync(inTrash, LINE_1.replace('meta', 'mETA'))
    utimesSync(inTrash, 1_700_000_000, 1_700_000_000)

    expect(await afterGrace()).toMatchObject({ deleted: 0, restored: 1 })
    expect(readFileSync(copy, 'utf8')).toBe(LINE_1.replace('meta', 'mETA'))
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

  it('stops listing empty folders once its time is up', async () => {
    for (let f = 0; f < 300; f += 1) {
      mkdirSync(
        join(home, 'sessions.orca-profile-merge', '2026', '11', String(f).padStart(3, '0')),
        {
          recursive: true
        }
      )
    }
    // Each listing costs five ticks, as on a slow disk.
    let tick = 0
    const before = listingsOf()
    const clock = vi
      .spyOn(Date, 'now')
      .mockImplementation(() => (tick += 1) + 5 * (listingsOf() - before))
    try {
      await verifyCodexAccountCopies({
        accountHome: home,
        storeHome: store,
        budget: { maxBytes: 4 * 1024 ** 3, deadline: Date.now() + 100 },
        version: 'test-empty',
        managedAccountsRoot: join(root, 'codex-accounts')
      })
    } finally {
      clock.mockRestore()
    }

    expect(listingsOf() - before).toBeLessThan(40)
  })
})
