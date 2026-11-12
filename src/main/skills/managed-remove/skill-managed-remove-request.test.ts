import {
  createSkillInstallHome,
  removeSkillInstallHomes
} from '../install/testing/skill-install-home'
import { installSharedSkill } from '../install/skill-installation'
import { cp, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { removeSharedSkillInstall } from './skill-managed-remove-request'

describe('managed skill removal ownership', () => {
  afterEach(removeSkillInstallHomes)
  it('never removes a byte-identical provider copy that was recorded as unowned', async () => {
    const { root, input, managementDependencies } = await createSkillInstallHome()
    const sourceSkill = join(root, 'source')
    const claude = join(root, 'home', '.claude', 'skills', 'test-skill')
    await mkdir(join(root, 'home', '.claude', 'skills'), { recursive: true })
    await cp(sourceSkill, claude, { recursive: true })
    const installed = await installSharedSkill(input)
    expect(installed.placements).toContainEqual(
      expect.objectContaining({ provider: 'claude', status: 'skipped' })
    )

    const removed = await removeSharedSkillInstall(
      {
        operationId: 'remove_identical_unowned',
        name: 'test-skill',
        destination: { scope: 'global' }
      },
      managementDependencies
    )

    expect(removed.status).toBe('partial')
    expect(await readFile(join(claude, 'SKILL.md'), 'utf8')).toContain('# Test')
  })

  it('removes owned placements even after the provider is no longer detected', async () => {
    const { root, input, managementDependencies } = await createSkillInstallHome()
    await installSharedSkill(input)

    const result = await removeSharedSkillInstall(
      { operationId: 'remove_1', name: 'test-skill', destination: { scope: 'global' } },
      managementDependencies
    )

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
    const { root, input, managementDependencies } = await createSkillInstallHome()
    await installSharedSkill(input)
    const canonical = join(root, 'home', '.agents', 'skills', 'test-skill')
    const claude = join(root, 'home', '.claude', 'skills', 'test-skill')
    await writeFile(join(canonical, 'local.md'), 'keep canonical')

    const conflict = await removeSharedSkillInstall(
      { operationId: 'remove_1', name: 'test-skill', destination: { scope: 'global' } },
      managementDependencies
    )
    expect(conflict.conflict?.kind).toBe('modified')
    expect(await readFile(join(canonical, 'local.md'), 'utf8')).toBe('keep canonical')

    await rm(claude, { force: true })
    await mkdir(claude)
    await writeFile(join(claude, 'local.md'), 'keep provider')
    const removed = await removeSharedSkillInstall(
      {
        operationId: 'remove_2',
        name: 'test-skill',
        destination: { scope: 'global' },
        conflictResolution: 'replace-and-discard-local'
      },
      managementDependencies
    )
    expect(removed.status).toBe('partial')
    expect(await readFile(join(claude, 'local.md'), 'utf8')).toBe('keep provider')
  })
})
