import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PackRefsLockOwnership } from './pack-refs-lock-ownership'

const roots: string[] = []

async function gitCommonDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-pack-refs-lock-'))
  roots.push(root)
  return root
}

function paths(commonDir: string): { lock: string; marker: string } {
  return {
    lock: join(commonDir, 'packed-refs.lock'),
    marker: join(commonDir, 'packed-refs.orca-owner')
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** A pid that cannot be running: the kernel rejects it outright. */
const DEAD_PID = 0x7fffffff
const ABANDONED_LOCK_AGE_MS = 15 * 60_000
const PID_REUSE_HORIZON_MS = 24 * 60 * 60_000

/** `claim` takes `now`, so age cases need no sleeping and no mtime forgery. */
function laterBy(ms: number): number {
  return Date.now() + ms
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('packed-refs lock ownership', () => {
  it('claims a repository with no lock and records the owner', async () => {
    const commonDir = await gitCommonDir()
    const { marker } = paths(commonDir)

    await expect(new PackRefsLockOwnership(commonDir).claim()).resolves.toEqual({ ok: true })

    await expect(readFile(marker, 'utf-8')).resolves.toContain(String(process.pid))
  })

  it('drops the owner marker on release', async () => {
    const commonDir = await gitCommonDir()
    const ownership = new PackRefsLockOwnership(commonDir)
    await ownership.claim()

    await ownership.release()

    await expect(exists(paths(commonDir).marker)).resolves.toBe(false)
  })

  it('refuses a lock it cannot prove is its own', async () => {
    const commonDir = await gitCommonDir()
    // A lock with no marker belongs to the user's own git, or to another tool.
    await writeFile(paths(commonDir).lock, 'someone else')

    await expect(new PackRefsLockOwnership(commonDir).claim()).resolves.toMatchObject({ ok: false })
    await expect(exists(paths(commonDir).lock)).resolves.toBe(true)
  })

  it('refuses a lock whose recorded owner is still running', async () => {
    const commonDir = await gitCommonDir()
    const { lock, marker } = paths(commonDir)
    await writeFile(lock, 'in progress')
    await writeFile(marker, JSON.stringify({ pid: process.pid }))

    await expect(
      new PackRefsLockOwnership(commonDir).claim(laterBy(ABANDONED_LOCK_AGE_MS + 1))
    ).resolves.toMatchObject({ ok: false })
    await expect(exists(lock)).resolves.toBe(true)
  })

  it('reclaims the lock its own dead process left behind', async () => {
    // SIGKILL and power loss bypass git's cleanup, and git never clears this itself.
    const commonDir = await gitCommonDir()
    const { lock, marker } = paths(commonDir)
    await writeFile(lock, 'abandoned mid-rewrite')
    await writeFile(marker, JSON.stringify({ pid: DEAD_PID }))

    const claimed = await new PackRefsLockOwnership(commonDir).claim(
      laterBy(ABANDONED_LOCK_AGE_MS + 1)
    )

    expect(claimed).toEqual({ ok: true })
    await expect(exists(lock)).resolves.toBe(false)
    await expect(readFile(marker, 'utf-8')).resolves.toContain(String(process.pid))
  })

  it('leaves a young lock alone even when the marker names a dead process', async () => {
    // A marker outlives its lock, so a foreign lock can appear after our death.
    // Age is the only thing separating our wreckage from somebody's live lock.
    const commonDir = await gitCommonDir()
    const { lock, marker } = paths(commonDir)
    await writeFile(marker, JSON.stringify({ pid: DEAD_PID }))
    await writeFile(lock, 'a different git process, started just now')

    await expect(new PackRefsLockOwnership(commonDir).claim()).resolves.toMatchObject({ ok: false })
    await expect(exists(lock)).resolves.toBe(true)
  })

  it('does not wedge a repository forever when the recorded pid was recycled', async () => {
    const commonDir = await gitCommonDir()
    const { lock, marker } = paths(commonDir)
    await writeFile(lock, 'abandoned mid-rewrite')
    // Our own pid stands in for a recycled one: alive, but not the process that wrote this.
    await writeFile(marker, JSON.stringify({ pid: process.pid }))

    await expect(
      new PackRefsLockOwnership(commonDir).claim(laterBy(ABANDONED_LOCK_AGE_MS + 1))
    ).resolves.toMatchObject({ ok: false })

    await expect(
      new PackRefsLockOwnership(commonDir).claim(laterBy(PID_REUSE_HORIZON_MS + 1))
    ).resolves.toEqual({ ok: true })
    await expect(exists(lock)).resolves.toBe(false)
  })

  it('refuses a lock whose marker is unreadable rather than guessing', async () => {
    const commonDir = await gitCommonDir()
    const { lock, marker } = paths(commonDir)
    await writeFile(lock, 'in progress')
    await writeFile(marker, 'not json')

    await expect(
      new PackRefsLockOwnership(commonDir).claim(laterBy(PID_REUSE_HORIZON_MS + 1))
    ).resolves.toMatchObject({ ok: false })
    await expect(exists(lock)).resolves.toBe(true)
  })

  it('claims cleanly when a marker outlived its lock', async () => {
    const commonDir = await gitCommonDir()
    await writeFile(paths(commonDir).marker, JSON.stringify({ pid: DEAD_PID }))

    await expect(new PackRefsLockOwnership(commonDir).claim()).resolves.toEqual({ ok: true })
  })
})

describe('stranded per-ref locks', () => {
  it('clears the empty refs/**/*.lock files its own dead process left behind', async () => {
    // `tempfile.c` opens the lock O_EXCL before linking it into the list the
    // signal handler walks, so a kill in that window leaves a 0-byte file that
    // Git never clears -- and `update-ref -d` on that ref then fails forever.
    const commonDir = await gitCommonDir()
    const namespace = join(commonDir, 'refs', 'remotes', 'origin')
    await mkdir(namespace, { recursive: true })
    await writeFile(join(namespace, 'main.lock'), '')
    await writeFile(join(namespace, 'main'), 'a'.repeat(40))
    await writeFile(paths(commonDir).marker, JSON.stringify({ pid: DEAD_PID }))

    await new PackRefsLockOwnership(commonDir).claim(laterBy(ABANDONED_LOCK_AGE_MS + 1))

    await expect(exists(join(namespace, 'main.lock'))).resolves.toBe(false)
    // The ref itself is untouched.
    await expect(exists(join(namespace, 'main'))).resolves.toBe(true)
  })

  it('leaves a non-empty ref lock alone, because a live writer is mid-write', async () => {
    const commonDir = await gitCommonDir()
    const namespace = join(commonDir, 'refs', 'heads')
    await mkdir(namespace, { recursive: true })
    await writeFile(join(namespace, 'busy.lock'), 'b'.repeat(40))
    await writeFile(paths(commonDir).marker, JSON.stringify({ pid: DEAD_PID }))

    await new PackRefsLockOwnership(commonDir).claim(laterBy(ABANDONED_LOCK_AGE_MS + 1))

    await expect(exists(join(namespace, 'busy.lock'))).resolves.toBe(true)
  })

  it('leaves ref locks alone when there is no marker naming a dead process', async () => {
    const commonDir = await gitCommonDir()
    const namespace = join(commonDir, 'refs', 'heads')
    await mkdir(namespace, { recursive: true })
    await writeFile(join(namespace, 'other.lock'), '')

    await new PackRefsLockOwnership(commonDir).claim(laterBy(ABANDONED_LOCK_AGE_MS + 1))

    await expect(exists(join(namespace, 'other.lock'))).resolves.toBe(true)
  })
})
