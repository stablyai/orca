// A hung mount (stalled NFS/SMB/WSL 9p) never settles an fs read. The model must fail the read by
// the caller's deadline, as Git's own timeout does, and must not queue more fs work behind it.
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import type * as FsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hang = vi.hoisted(
  (): { prefix: string; only: string | null; started: number; held: (() => void)[] } => ({
    prefix: '',
    // One fs function to hang, or every one of them.
    only: null,
    started: 0,
    held: []
  })
)
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  const hangUnderPrefix =
    <A extends unknown[], R>(read: (...args: A) => Promise<R>, name: string) =>
    (...args: A): Promise<R> => {
      if (
        hang.prefix &&
        String(args[0]).startsWith(hang.prefix) &&
        (hang.only === null || hang.only === name)
      ) {
        hang.started += 1
        // Held until the test lets the mount recover; then the op runs for real.
        return new Promise<R>((resolve, reject) => {
          hang.held.push(() => void read(...args).then(resolve, reject))
        })
      }
      return read(...args)
    }
  return {
    ...actual,
    stat: hangUnderPrefix(actual.stat, 'stat'),
    lstat: hangUnderPrefix(actual.lstat, 'lstat'),
    readdir: hangUnderPrefix(actual.readdir, 'readdir'),
    readFile: hangUnderPrefix(actual.readFile, 'readFile'),
    realpath: hangUnderPrefix(actual.realpath, 'realpath')
  }
})

import {
  _getWorktreeMembershipModelForTests,
  _resetWorktreeMembershipModelsForTests,
  markWorktreeMembershipDirty,
  readWorktreeMembership,
  WorktreeMembershipTimeoutError
} from './worktree-membership-store'
import { MEMBERSHIP_REUSE_WINDOW_MS } from './worktree-membership-model'

const execFileAsync = promisify(execFile)

let scratchDir = ''
let repoPath = ''

async function git(args: string[], cwd = repoPath): Promise<void> {
  await execFileAsync('git', args, { cwd })
}

beforeEach(async () => {
  scratchDir = await realpath(await mkdtemp(join(tmpdir(), 'orca-membership-deadline-')))
  repoPath = join(scratchDir, 'repo')
  await mkdir(repoPath, { recursive: true })
  await git(['init', '-q', '-b', 'main'])
  await writeFile(join(repoPath, 'seed.txt'), 'seed\n')
  await git(['add', '-A'])
  await git(['-c', 'user.email=d@example.invalid', '-c', 'user.name=D', 'commit', '-qm', 'seed'])
  await git(['worktree', 'add', '-q', join(scratchDir, 'linked'), '-b', 'linked'])
  _resetWorktreeMembershipModelsForTests()
  hang.prefix = ''
  hang.only = null
  hang.started = 0
  hang.held.length = 0
})

afterEach(async () => {
  hang.prefix = ''
  vi.restoreAllMocks()
  _resetWorktreeMembershipModelsForTests()
  await rm(scratchDir, { recursive: true, force: true })
})

describe('worktree membership model on a hung mount', () => {
  it('fails a warm read by its deadline and starts no fs work behind the stalled one', async () => {
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    await readWorktreeMembership(repoPath)
    hang.prefix = join(repoPath, '.git')
    now += MEMBERSHIP_REUSE_WINDOW_MS

    await expect(readWorktreeMembership(repoPath, { timeout: 50 })).rejects.toBeInstanceOf(
      WorktreeMembershipTimeoutError
    )
    const stalledReads = hang.started
    for (let round = 0; round < 3; round++) {
      markWorktreeMembershipDirty(repoPath)
      await expect(readWorktreeMembership(repoPath, { timeout: 50 })).rejects.toBeInstanceOf(
        WorktreeMembershipTimeoutError
      )
    }
    expect(hang.started).toBe(stalledReads)
  })

  it('runs one derivation at a time however many readers arrive while the disk hangs', async () => {
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    await readWorktreeMembership(repoPath)
    const model = _getWorktreeMembershipModelForTests(repoPath)!
    const derivationsBefore = model.startedDerivations
    hang.prefix = join(repoPath, '.git')
    const reads: ReturnType<typeof readWorktreeMembership>[] = []
    for (let reader = 0; reader < 6; reader++) {
      now += MEMBERSHIP_REUSE_WINDOW_MS + 50
      reads.push(readWorktreeMembership(repoPath, { timeout: 60_000 }))
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(model.startedDerivations - derivationsBefore).toBe(1)
    const stalledReads = hang.started

    // The mount recovers: the running derivation, then one shared follow-up, answer everyone.
    hang.prefix = ''
    while (hang.held.length > 0) {
      hang.held.shift()!()
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    await Promise.all(reads)
    expect(model.startedDerivations - derivationsBefore).toBe(2)
    expect(stalledReads).toBeGreaterThan(0)
  })

  it('keeps nothing of the readers that gave up on a hung derivation', async () => {
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    await readWorktreeMembership(repoPath)
    const model = _getWorktreeMembershipModelForTests(repoPath)!
    hang.prefix = join(repoPath, '.git')
    now += MEMBERSHIP_REUSE_WINDOW_MS
    const first = readWorktreeMembership(repoPath, { timeout: 1 })
    await expect(first).rejects.toBeInstanceOf(WorktreeMembershipTimeoutError)
    for (let reader = 0; reader < 50; reader++) {
      now += MEMBERSHIP_REUSE_WINDOW_MS
      await expect(readWorktreeMembership(repoPath, { timeout: 1 })).rejects.toBeInstanceOf(
        WorktreeMembershipTimeoutError
      )
    }
    expect(model.inFlight?.work.waiterCount).toBe(0)
    expect(model.followUp?.waiterCount).toBe(0)
  })

  it('keeps nothing of the readers that gave up on a hung cold build', async () => {
    hang.prefix = join(repoPath, '.git')
    for (let reader = 0; reader < 50; reader++) {
      await expect(readWorktreeMembership(repoPath, { timeout: 1 })).rejects.toBeInstanceOf(
        WorktreeMembershipTimeoutError
      )
    }
    expect(_getWorktreeMembershipModelForTests(repoPath)?.building?.work.waiterCount).toBe(0)
  })

  it('fails a read of a folder files cannot place by its deadline when stamping it hangs', async () => {
    const plain = join(scratchDir, 'plain-folder')
    await mkdir(plain)
    // Only the stamp of `<folder>/.git` lstats it; the build's own layout probe uses stat.
    hang.prefix = join(plain, '.git')
    hang.only = 'lstat'
    const read = readWorktreeMembership(plain, { timeout: 50 })
    const outcome = await Promise.race([
      read.then(
        () => 'resolved',
        (error: unknown) => (error instanceof WorktreeMembershipTimeoutError ? 'timed out' : error)
      ),
      new Promise((resolve) => setTimeout(() => resolve('still pending'), 1_000))
    ])
    expect(outcome).toBe('timed out')
    expect(hang.started).toBe(1)
  })

  it('fails a cold build by its deadline and joins it instead of building again', async () => {
    hang.prefix = join(repoPath, '.git')
    await expect(readWorktreeMembership(repoPath, { timeout: 50 })).rejects.toBeInstanceOf(
      WorktreeMembershipTimeoutError
    )
    const stalledReads = hang.started
    await expect(readWorktreeMembership(repoPath, { timeout: 50 })).rejects.toBeInstanceOf(
      WorktreeMembershipTimeoutError
    )
    expect(hang.started).toBe(stalledReads)
  })

  it('answers a read inside the reuse window without touching the disk', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.now())
    const { rows } = await readWorktreeMembership(repoPath)
    hang.prefix = scratchDir
    await expect(readWorktreeMembership(repoPath, { timeout: 50 })).resolves.toEqual({
      rows,
      fromModel: true
    })
    expect(hang.started).toBe(0)
  })
})
