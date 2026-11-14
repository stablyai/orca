import { createSkillInstallHome, removeSkillInstallHomes } from './testing/skill-install-home'
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'

import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { installSharedSkill } from './skill-installation'

import { nativeSkillInstallFilesystem } from '../filesystem/skill-install-filesystem'
afterEach(removeSkillInstallHomes)

describe('skill install service', () => {
  it('leaves an unowned provider copy untouched and reports partial coverage', async () => {
    const { root, input } = await createSkillInstallHome()
    const claude = join(root, 'home', '.claude', 'skills', 'test-skill')
    await mkdir(claude, { recursive: true })
    await writeFile(join(claude, 'SKILL.md'), 'unowned')

    const result = await installSharedSkill(input)

    expect(result.status).toBe('partial')
    expect(result.placements.at(-1)).toMatchObject({
      provider: 'claude',
      status: 'skipped',
      errorCategory: 'skill-placement-unowned'
    })
    expect(await readFile(join(claude, 'SKILL.md'), 'utf8')).toBe('unowned')
  })

  it('preserves the committed canonical install when cancellation reaches provider placement', async () => {
    const { root, input } = await createSkillInstallHome()
    const controller = new AbortController()
    const canonical = join(root, 'home', '.agents', 'skills', 'test-skill')
    const cancellingFilesystem = {
      ...nativeSkillInstallFilesystem,
      rename: async (source: string, target: string): Promise<void> => {
        await nativeSkillInstallFilesystem.rename(source, target)
        if (target === canonical) {
          controller.abort()
        }
      }
    }

    const interrupted = await installSharedSkill({
      ...input,
      filesystem: cancellingFilesystem,
      signal: controller.signal
    })

    expect(interrupted.status).toBe('partial')
    expect(interrupted.placements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: 'agent-skills', status: 'installed' }),
        expect.objectContaining({
          provider: 'claude',
          status: 'skipped',
          errorCategory: 'skill-placement-cancelled'
        })
      ])
    )
    expect(await readFile(join(canonical, 'SKILL.md'), 'utf8')).toContain('# Test')

    const retried = await installSharedSkill({ ...input, operationId: 'operation_retry' })
    expect(retried.status).toBe('unchanged')
    expect(await realpath(join(root, 'home', '.claude', 'skills', 'test-skill'))).toBe(
      await realpath(canonical)
    )
  })

  it('cleans an interrupted provider copy and repairs coverage on retry', async () => {
    const { root, input } = await createSkillInstallHome()
    const canonical = join(root, 'home', '.agents', 'skills', 'test-skill')
    const claude = join(root, 'home', '.claude', 'skills', 'test-skill')
    let deniedCopyObservation = false
    const interruptedFilesystem = {
      ...nativeSkillInstallFilesystem,
      createAlias: async () => {
        throw new Error('injected-alias-denial')
      },
      observeSkill: async (path: string) => {
        if (path === claude && !deniedCopyObservation) {
          deniedCopyObservation = true
          throw new Error('injected-copy-interruption')
        }
        return nativeSkillInstallFilesystem.observeSkill(path)
      }
    }

    const interrupted = await installSharedSkill({ ...input, filesystem: interruptedFilesystem })
    expect(interrupted).toMatchObject({
      status: 'partial',
      placements: expect.arrayContaining([
        expect.objectContaining({
          provider: 'claude',
          status: 'failed',
          errorCategory: 'skill-placement-create-failed'
        })
      ])
    })
    await expect(lstat(claude)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(canonical, 'SKILL.md'), 'utf8')).toContain('# Test')

    const retried = await installSharedSkill({ ...input, operationId: 'operation_retry' })
    expect(retried.status).toBe('unchanged')
    expect(await realpath(claude)).toBe(await realpath(canonical))
  })
})
