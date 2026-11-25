import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'

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
  it('refuses a lock it cannot prove is its own', async () => {
    const commonDir = await gitCommonDir()
    await writeFile(paths(commonDir).lock, 'someone else')

    await expect(new PackRefsLockOwnership(commonDir).claim()).resolves.toMatchObject({ ok: false })
    await expect(exists(paths(commonDir).lock)).resolves.toBe(true)
  })

  it('reclaims the lock its own dead process left behind', async () => {
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
    // Markers can outlive locks; a fresh foreign lock must remain untouched.
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
})
