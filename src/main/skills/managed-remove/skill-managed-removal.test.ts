import {
  createSkillInstallHome,
  removeSkillInstallHomes
} from '../install/testing/skill-install-home'
import { cp, lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'

import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { installSharedSkill } from '../install/skill-installation'
import { removeSharedSkill } from './skill-managed-removal'
import { nativeSkillInstallFilesystem } from '../filesystem/skill-install-filesystem'
afterEach(removeSkillInstallHomes)

describe('managed skill removal', () => {
  it('never removes a byte-identical provider copy that was recorded as unowned', async () => {
    const { root, input } = await createSkillInstallHome()
    const sourceSkill = join(root, 'source')
    const claude = join(root, 'home', '.claude', 'skills', 'test-skill')
    await mkdir(join(root, 'home', '.claude', 'skills'), { recursive: true })
    await cp(sourceSkill, claude, { recursive: true })
    const installed = await installSharedSkill(input)
    expect(installed.placements).toContainEqual(
      expect.objectContaining({ provider: 'claude', status: 'skipped' })
    )

    const removed = await removeSharedSkill({
      operationId: 'remove_identical_unowned',
      skillName: 'test-skill',
      scope: 'global',
      homeDirectory: input.homeDirectory,
      orcaStateDirectory: input.orcaStateDirectory,
      detectedProviders: input.detectedProviders
    })

    expect(removed.status).toBe('partial')
    expect(await readFile(join(claude, 'SKILL.md'), 'utf8')).toContain('# Test')
  })

  it('removes owned placements even after the provider is no longer detected', async () => {
    const { root, input } = await createSkillInstallHome()
    await installSharedSkill(input)

    const result = await removeSharedSkill({
      operationId: 'remove_1',
      skillName: 'test-skill',
      scope: 'global',
      homeDirectory: input.homeDirectory,
      orcaStateDirectory: input.orcaStateDirectory,
      detectedProviders: []
    })

    expect(result.status).toBe('removed')
    await expect(
      lstat(join(root, 'home', '.agents', 'skills', 'test-skill'))
    ).rejects.toMatchObject({
      code: 'ENOENT'
    })
    await expect(
      lstat(join(root, 'home', '.claude', 'skills', 'test-skill'))
    ).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('preserves modified canonical and provider content during removal', async () => {
    const { root, input } = await createSkillInstallHome()
    await installSharedSkill(input)
    const canonical = join(root, 'home', '.agents', 'skills', 'test-skill')
    const claude = join(root, 'home', '.claude', 'skills', 'test-skill')
    await writeFile(join(canonical, 'local.md'), 'keep canonical')

    const conflict = await removeSharedSkill({
      operationId: 'remove_1',
      skillName: 'test-skill',
      scope: 'global',
      homeDirectory: input.homeDirectory,
      orcaStateDirectory: input.orcaStateDirectory,
      detectedProviders: input.detectedProviders
    })
    expect(conflict.conflict?.kind).toBe('modified')
    expect(await readFile(join(canonical, 'local.md'), 'utf8')).toBe('keep canonical')

    await rm(claude, { force: true })
    await mkdir(claude)
    await writeFile(join(claude, 'local.md'), 'keep provider')
    const removed = await removeSharedSkill({
      operationId: 'remove_2',
      skillName: 'test-skill',
      scope: 'global',
      homeDirectory: input.homeDirectory,
      orcaStateDirectory: input.orcaStateDirectory,
      detectedProviders: input.detectedProviders,
      conflictResolution: 'replace-and-discard-local'
    })
    expect(removed.status).toBe('partial')
    expect(await readFile(join(claude, 'local.md'), 'utf8')).toBe('keep provider')
  })

  it('restores moved placements when removal is interrupted', async () => {
    const { root, input } = await createSkillInstallHome()
    await installSharedSkill(input)
    const canonical = join(root, 'home', '.agents', 'skills', 'test-skill')
    const claude = join(root, 'home', '.claude', 'skills', 'test-skill')
    let renameCount = 0
    const interruptedFilesystem = {
      ...nativeSkillInstallFilesystem,
      rename: async (source: string, target: string): Promise<void> => {
        renameCount += 1
        if (renameCount === 2) {
          throw new Error('injected-removal-interruption')
        }
        await nativeSkillInstallFilesystem.rename(source, target)
      }
    }

    await expect(
      removeSharedSkill({
        operationId: 'remove_interrupted',
        skillName: 'test-skill',
        scope: 'global',
        homeDirectory: input.homeDirectory,
        orcaStateDirectory: input.orcaStateDirectory,
        detectedProviders: input.detectedProviders,
        filesystem: interruptedFilesystem
      })
    ).rejects.toThrow('injected-removal-interruption')
    expect(await realpath(claude)).toBe(await realpath(canonical))

    const retried = await removeSharedSkill({
      operationId: 'remove_retried',
      skillName: 'test-skill',
      scope: 'global',
      homeDirectory: input.homeDirectory,
      orcaStateDirectory: input.orcaStateDirectory,
      detectedProviders: input.detectedProviders
    })
    expect(retried.status).toBe('removed')
  })
})
