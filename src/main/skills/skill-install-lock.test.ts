import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { acquireSkillInstallLock, skillInstallLockPath } from './skill-install-lock'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('skill install lock', () => {
  it('reclaims a fresh lock whose process was killed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skill-lock-test-'))
    roots.push(root)
    const lockPath = skillInstallLockPath(join(root, 'state'), join(root, 'skills', 'alpha'))
    await mkdir(dirname(lockPath), { recursive: true })
    await writeFile(
      lockPath,
      JSON.stringify({ token: 'dead-owner', pid: 2_147_483_647, createdAt: Date.now() })
    )

    const release = await acquireSkillInstallLock({ path: lockPath, timeoutMs: 100 })
    expect(JSON.parse(await readFile(lockPath, 'utf8')).token).not.toBe('dead-owner')
    await release()
    await expect(readFile(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
