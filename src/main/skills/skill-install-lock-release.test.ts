import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanupReleasedSkillInstallLock } from './skill-install-lock-release'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('cleanupReleasedSkillInstallLock', () => {
  it('keeps a released lock recoverable when directory removal races', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skill-lock-release-test-'))
    roots.push(root)
    const releasePath = join(root, 'released')
    const token = '11111111-1111-4111-8111-111111111111'
    await mkdir(releasePath)
    await Promise.all([
      writeFile(join(releasePath, `${token}.owner`), 'owner'),
      writeFile(join(releasePath, `${token}.released`), '')
    ])

    const removeDirectory = async (): Promise<void> => {
      const error = new Error('injected-rmdir-race') as NodeJS.ErrnoException
      error.code = 'ENOTEMPTY'
      throw error
    }

    await expect(
      cleanupReleasedSkillInstallLock(releasePath, token, removeDirectory)
    ).resolves.toBeUndefined()
    await expect(readdir(releasePath)).resolves.toEqual([])
  })
})
