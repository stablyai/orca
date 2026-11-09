import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  acquireSkillInstallLock,
  reclaimDeadSkillInstallLocks,
  skillInstallLockPath
} from './skill-install-lock'
import './skill-install-lock-owner'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function readPublishedOwner(lockPath: string): Promise<Record<string, unknown>> {
  const ownerName = (await readdir(lockPath)).find((name) => name.endsWith('.owner'))
  if (!ownerName) {
    throw new Error('missing-owner')
  }
  return JSON.parse(await readFile(join(lockPath, ownerName), 'utf8')) as Record<string, unknown>
}

describe('skill install lock', () => {
  it('reclaims a fresh legacy lock whose process was killed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skill-lock-test-'))
    roots.push(root)
    const lockPath = skillInstallLockPath(join(root, 'state'), join(root, 'skills', 'alpha'))
    await mkdir(dirname(lockPath), { recursive: true })
    await writeFile(
      lockPath,
      JSON.stringify({ token: 'dead-owner', pid: 2_147_483_647, createdAt: Date.now() })
    )

    // Reclaim needs fsync plus a 50ms retry; allow CI load rather than timing out on legacy ENOTDIR.
    const release = await acquireSkillInstallLock({ path: lockPath, timeoutMs: 5_000 })
    expect((await readPublishedOwner(lockPath)).token).not.toBe('dead-owner')
    await release()
    await expect(readdir(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reclaims abandoned legacy owner files at startup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skill-lock-test-'))
    roots.push(root)
    const stateDirectory = join(root, 'state')
    const lockPath = skillInstallLockPath(stateDirectory, join(root, 'skills', 'alpha'))
    const ownerPath = `${lockPath}.11111111-1111-4111-8111-111111111111.owner`
    await mkdir(dirname(ownerPath), { recursive: true })
    await writeFile(
      ownerPath,
      JSON.stringify({ token: 'abandoned-owner', pid: 2_147_483_647, createdAt: Date.now() })
    )

    await expect(reclaimDeadSkillInstallLocks(stateDirectory)).resolves.toMatchObject({
      scanned: 1,
      reclaimed: 1
    })
    await expect(readFile(ownerPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reclaims dead locks, abandoned candidates, and completed releases at startup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skill-lock-test-'))
    roots.push(root)
    const stateDirectory = join(root, 'state')
    const deadPath = skillInstallLockPath(stateDirectory, join(root, 'skills', 'alpha'))
    const releasedLockPath = skillInstallLockPath(stateDirectory, join(root, 'skills', 'beta'))
    const candidateLockPath = skillInstallLockPath(stateDirectory, join(root, 'skills', 'gamma'))
    const deadToken = '11111111-1111-4111-8111-111111111111'
    const releasedToken = '22222222-2222-4222-8222-222222222222'
    const candidateToken = '33333333-3333-4333-8333-333333333333'
    await mkdir(deadPath, { recursive: true })
    const releasedPath = `${releasedLockPath}.${releasedToken}.released`
    const candidatePath = `${candidateLockPath}.${candidateToken}.candidate`
    await mkdir(releasedPath, { recursive: true })
    await mkdir(candidatePath, { recursive: true })
    await writeFile(
      join(deadPath, `${deadToken}.owner`),
      JSON.stringify({ token: deadToken, pid: 2_147_483_647, createdAt: Date.now() })
    )
    await writeFile(
      join(releasedPath, `${releasedToken}.owner`),
      JSON.stringify({ token: releasedToken, pid: process.pid, createdAt: Date.now() })
    )
    await writeFile(
      join(candidatePath, `${candidateToken}.owner`),
      JSON.stringify({ token: candidateToken, pid: 2_147_483_647, createdAt: Date.now() })
    )

    await expect(reclaimDeadSkillInstallLocks(stateDirectory)).resolves.toEqual({
      scanned: 3,
      reclaimed: 3,
      truncated: false
    })
  })

  it('continues startup recovery past a non-empty released lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skill-lock-test-'))
    roots.push(root)
    const stateDirectory = join(root, 'state')
    const lockDirectory = join(stateDirectory, 'locks')
    const releasedToken = '11111111-1111-4111-8111-111111111111'
    const deadToken = '22222222-2222-4222-8222-222222222222'
    const releasedPath = join(lockDirectory, `${'0'.repeat(64)}.lock.${releasedToken}.released`)
    const deadPath = join(lockDirectory, `${'f'.repeat(64)}.lock`)
    await mkdir(releasedPath, { recursive: true })
    await mkdir(deadPath)
    await writeFile(join(releasedPath, 'unexpected-entry'), 'preserve')
    await writeFile(
      join(deadPath, `${deadToken}.owner`),
      JSON.stringify({ token: deadToken, pid: 2_147_483_647, createdAt: Date.now() })
    )

    await expect(reclaimDeadSkillInstallLocks(stateDirectory)).resolves.toEqual({
      scanned: 2,
      reclaimed: 1,
      truncated: false
    })
    await expect(readdir(releasedPath)).resolves.toEqual(['unexpected-entry'])
    await expect(readdir(deadPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
