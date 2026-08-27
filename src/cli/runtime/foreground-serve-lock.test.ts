import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  acquireForegroundServeLock,
  getForegroundServeLockOwnerPath,
  getForegroundServeLockPath,
  releaseForegroundServeLock
} from './foreground-serve-lock'

const temporaryDirectories: string[] = []

async function isolatedUserData(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'orca-serve-lock-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(() =>
  Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })))
)

async function writeStaleLock(userDataPath: string, pid: number): Promise<void> {
  const lockDir = getForegroundServeLockPath(userDataPath)
  await mkdir(lockDir, { recursive: true })
  await writeFile(join(lockDir, 'owner.json'), `${JSON.stringify({ pid, startedAt: 1 })}\n`, {
    encoding: 'utf8',
    mode: 0o600
  })
}

async function readOwnerPid(userDataPath: string): Promise<number> {
  const record = JSON.parse(
    await readFile(getForegroundServeLockOwnerPath(userDataPath), 'utf8')
  ) as {
    pid: number
  }
  return record.pid
}

describe('acquireForegroundServeLock', () => {
  it('creates an exclusive lock directory for the userData profile', async () => {
    const userDataPath = await isolatedUserData()

    const lock = await acquireForegroundServeLock(userDataPath)

    expect(lock).toEqual({
      path: getForegroundServeLockPath(userDataPath),
      pid: process.pid
    })
    expect(await readOwnerPid(userDataPath)).toBe(process.pid)
  })

  it('returns null when another live process already holds the lock', async () => {
    const userDataPath = await isolatedUserData()
    const first = await acquireForegroundServeLock(userDataPath)
    expect(first).not.toBeNull()

    await expect(acquireForegroundServeLock(userDataPath)).resolves.toBeNull()
  })

  it('lets only one of two concurrent acquires win', async () => {
    const userDataPath = await isolatedUserData()

    const [first, second] = await Promise.all([
      acquireForegroundServeLock(userDataPath),
      acquireForegroundServeLock(userDataPath)
    ])

    const winners = [first, second].filter((lock) => lock !== null)
    const losers = [first, second].filter((lock) => lock === null)
    expect(winners).toHaveLength(1)
    expect(losers).toHaveLength(1)
    expect(winners[0]?.pid).toBe(process.pid)
  })

  it('reclaims a lock whose owner pid is dead', async () => {
    const userDataPath = await isolatedUserData()
    await writeStaleLock(userDataPath, findUnusedPid())

    const lock = await acquireForegroundServeLock(userDataPath)

    expect(lock?.pid).toBe(process.pid)
    expect(await readOwnerPid(userDataPath)).toBe(process.pid)
  })

  it('lets only one of two stale-lock reclaimers win', async () => {
    const userDataPath = await isolatedUserData()
    await writeStaleLock(userDataPath, findUnusedPid())

    const [first, second] = await Promise.all([
      acquireForegroundServeLock(userDataPath),
      acquireForegroundServeLock(userDataPath)
    ])

    const winners = [first, second].filter((lock) => lock !== null)
    const losers = [first, second].filter((lock) => lock === null)
    expect(winners).toHaveLength(1)
    expect(losers).toHaveLength(1)
    expect(winners[0]?.pid).toBe(process.pid)
    expect(await readOwnerPid(userDataPath)).toBe(process.pid)
  })
})

describe('releaseForegroundServeLock', () => {
  it('removes the lock so a later acquire can succeed', async () => {
    const userDataPath = await isolatedUserData()
    const lock = await acquireForegroundServeLock(userDataPath)
    expect(lock).not.toBeNull()

    await releaseForegroundServeLock(lock!)

    await expect(acquireForegroundServeLock(userDataPath)).resolves.toMatchObject({
      pid: process.pid
    })
  })

  it('does not remove a lock owned by a different pid', async () => {
    const userDataPath = await isolatedUserData()
    const lock = await acquireForegroundServeLock(userDataPath)
    expect(lock).not.toBeNull()

    await releaseForegroundServeLock({ path: lock!.path, pid: lock!.pid + 1 })

    expect(await readOwnerPid(userDataPath)).toBe(process.pid)
  })
})

function findUnusedPid(seed = 200_000): number {
  let pid = Math.max(seed, process.pid + 10_000)
  while (pid < 2_000_000) {
    try {
      process.kill(pid, 0)
      pid += 1
    } catch {
      return pid
    }
  }
  return 2_000_000
}
