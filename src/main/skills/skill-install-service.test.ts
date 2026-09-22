import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSkillPackageArchive } from './skill-package-creation'
import {
  installSharedSkill,
  removeSharedSkill,
  type SkillInstallServiceInput
} from './skill-install-service'
import { nativeSkillInstallFilesystem } from './skill-install-filesystem'

const temporaryDirectories: string[] = []

async function fixture(): Promise<{
  root: string
  input: SkillInstallServiceInput
}> {
  const root = await mkdtemp(join(tmpdir(), 'orca-skill-service-test-'))
  temporaryDirectories.push(root)
  const source = join(root, 'source')
  await mkdir(source)
  await writeFile(
    join(source, 'SKILL.md'),
    '---\nname: test-skill\ndescription: Test\n---\n\n# Test\n'
  )
  const archive = await createSkillPackageArchive({
    sourceDirectory: source,
    archivePath: join(root, 'package.tar.gz'),
    packageId: 'package_1',
    versionId: 'version_1'
  })
  return {
    root,
    input: {
      operationId: 'operation_1',
      archivePath: archive.archivePath,
      scope: 'global',
      homeDirectory: join(root, 'home'),
      orcaStateDirectory: join(root, 'orca-state'),
      detectedProviders: ['codex', 'claude'],
      destinationIdentity: 'global:test-host',
      hostIdentity: 'test-host',
      expectedArchiveSha256: archive.archiveSha256,
      expectedPackageDigest: archive.manifest.packageDigest,
      expectedPackageId: archive.manifest.packageId,
      expectedVersionId: archive.manifest.versionId
    }
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true }))
  )
})

describe('skill install service', () => {
  it('installs one canonical Codex copy and aliases the other agent home to it', async () => {
    const { root, input } = await fixture()
    const result = await installSharedSkill(input)
    const canonical = join(root, 'home', '.agents', 'skills', 'test-skill')
    const claude = join(root, 'home', '.claude', 'skills', 'test-skill')

    expect(result.status).toBe('installed')
    expect(result.placements).toHaveLength(2)
    expect(await realpath(claude)).toBe(await realpath(canonical))
  })

  it('authorizes a historical provider root before relocating it', async () => {
    const { root, input } = await fixture()
    const oldRoot = join(root, 'old-claude', 'skills')
    await installSharedSkill({
      ...input,
      detectedProviders: ['claude'],
      providerRootOverrides: { claude: oldRoot },
      filesystem: { ...nativeSkillInstallFilesystem }
    })
    const authorizeRoots = vi.fn()

    await installSharedSkill({
      ...input,
      detectedProviders: ['claude'],
      providerRootOverrides: { claude: join(root, 'new-claude', 'skills') },
      filesystem: { ...nativeSkillInstallFilesystem, authorizeRoots }
    })

    expect(authorizeRoots).toHaveBeenCalledWith([oldRoot])
  })

  it('leaves an unowned provider copy untouched and reports partial coverage', async () => {
    const { root, input } = await fixture()
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

  it('never removes a byte-identical provider copy that was recorded as unowned', async () => {
    const { root, input } = await fixture()
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

  it('keeps an unchanged canonical install partial when a provider placement is unowned', async () => {
    const { root, input } = await fixture()
    await installSharedSkill({ ...input, detectedProviders: ['codex'] })
    const claude = join(root, 'home', '.claude', 'skills', 'test-skill')
    await mkdir(claude, { recursive: true })
    await writeFile(join(claude, 'SKILL.md'), 'unowned')

    const result = await installSharedSkill(input)

    expect(result).toMatchObject({
      status: 'partial',
      placements: expect.arrayContaining([
        expect.objectContaining({
          provider: 'claude',
          status: 'skipped',
          errorCategory: 'skill-placement-unowned'
        })
      ])
    })
  })

  it('does not report success when normal skill discovery cannot observe the canonical copy', async () => {
    const { root, input } = await fixture()

    const result = await installSharedSkill({
      ...input,
      discover: async () => ({ skills: [], sources: [], scannedAt: Date.now() })
    })

    expect(result).toMatchObject({
      status: 'failed',
      errorCategory: 'skill-discovery-canonical-missing',
      failure: { category: 'provider-placement', retryable: true }
    })
    expect(
      await readFile(join(root, 'home', '.agents', 'skills', 'test-skill', 'SKILL.md'), 'utf8')
    ).toContain('# Test')
  })

  it('removes owned placements even after the provider is no longer detected', async () => {
    const { root, input } = await fixture()
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

  it('removes an owned placement when its provider is deselected', async () => {
    const { root, input } = await fixture()
    await installSharedSkill(input)
    const claude = join(root, 'home', '.claude', 'skills', 'test-skill')

    const updated = await installSharedSkill({
      ...input,
      operationId: 'operation_without_claude',
      detectedProviders: ['codex']
    })

    expect(updated.status).toBe('unchanged')
    await expect(lstat(claude)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(updated.placements).toEqual([
      expect.objectContaining({ provider: 'agent-skills', topology: 'canonical-copy' })
    ])
  })

  it('preserves modified canonical and provider content during removal', async () => {
    const { root, input } = await fixture()
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
    const { root, input } = await fixture()
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

  it('preserves the committed canonical install when cancellation reaches provider placement', async () => {
    const { root, input } = await fixture()
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
    const { root, input } = await fixture()
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
