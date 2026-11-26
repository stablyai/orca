import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanUpCodexAccountCopies } from './codex-account-copies-cleanup'
import { runCodexAccountCopiesRequest } from './codex-account-copies'
import type { CodexHistoryMoveOutcome } from '../../../telemetry/codex-history-move-telemetry'

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
    beforeDelete?: () => void
    /** False: Codex's lock coordination can't be taken. */
    locks?: boolean
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
    findOpen: async (paths) => (options.open ? options.open(paths) : new Set()),
    holdLocks: async () =>
      options.locks === false ? null : { stillHeld: () => true, release: async () => {} },
    worker: {
      call: async (request) => {
        if (request.op === 'delete') {
          options.beforeDelete?.()
        }
        return runCodexAccountCopiesRequest(request).catch((error: unknown) => ({
          ok: false as const,
          message: String(error)
        }))
      },
      stop: async () => {}
    }
  })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-codex-copies-'))
  home = join(root, 'codex-accounts', 'acct-1', 'home')
  store = join(root, 'codex')
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, '.orca-managed-home'), 'acct-1\n')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('cleanUpCodexAccountCopies', () => {
  it('deletes a copy identical to or a prefix of its original, keeps one with bytes it lacks', async () => {
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
    expect(tally).toMatchObject({ deleted: 2, differs: 2, missing_original: 1 })
    expect(existsSync(storeFile())).toBe(true)
  })

  it('keeps a copy whose thread a Codex has open to append, before it writes anything', async () => {
    put(storeFile(), LINE_1)
    const copy = put(conflictCopy(), LINE_1)
    // Held: with coordination held, a lock file still there belongs to a live Codex.
    put(join(store, 'thread-writer-locks', '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b.lock'), '')

    expect(await run()).toMatchObject({ deleted: 0, busy: 1 })
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

    await run({ beforeDelete: () => writeFileSync(storeFile(), LINE_1.slice(0, 4)) })

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
    expect(tally).toMatchObject({ compressed: 3, deleted: 1 })
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

    await run({ beforeDelete: () => appendFileSync(copy, LINE_2.replace('second', 'other')) })

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
