import { readdirSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SKILL_INSTALL_CANCELLED_FAILURE } from '../../shared/skill-install-failure'
import { createSkillBundleArchive } from './skill-bundle-creation'
import { installSkillBundle } from './skill-bundle-install-service'
import { listManagedSkillInstalls } from './skill-install-provenance'

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'orca-skill-bundle-install-test-'))
  temporaryDirectories.push(directory)
  return directory
}

async function createSkill(root: string, name: string): Promise<string> {
  const directory = join(root, name)
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name}\n---\n\n# ${name}\n`
  )
  return directory
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true }))
  )
})

describe('skill bundle installation', () => {
  it('cancels before extracting bundle bytes and removes staging', async () => {
    const root = await temporaryDirectory()
    const source = await createSkill(join(root, 'sources'), 'alpha-skill')
    const bundle = await createSkillBundleArchive({
      sources: [{ sourceDirectory: source }],
      archivePath: join(root, 'bundle.tar.gz'),
      packageId: 'package_cancel',
      versionId: 'version_cancel',
      bundleName: 'team-skills'
    })
    const controller = new AbortController()
    controller.abort()

    await expect(
      installSkillBundle({
        operationId: 'operation_cancel',
        archivePath: bundle.archivePath,
        packageId: bundle.manifest.packageId,
        versionId: bundle.manifest.versionId,
        bundleDigest: bundle.manifest.bundleDigest,
        selectedSkillIds: ['alpha-skill'],
        expectedArchiveSha256: bundle.archiveSha256,
        scope: 'global',
        homeDirectory: join(root, 'home'),
        orcaStateDirectory: join(root, 'state'),
        detectedProviders: [],
        destinationIdentity: 'local-global',
        hostIdentity: 'host_1',
        signal: controller.signal
      })
    ).rejects.toMatchObject({ data: SKILL_INSTALL_CANCELLED_FAILURE })
    await expect(readdir(join(root, 'home', '.agents', 'skills'))).resolves.toEqual([])
  })

  it('cancels during bundle extraction and removes its journal and partial bytes', async () => {
    const root = await temporaryDirectory()
    const source = await createSkill(join(root, 'sources'), 'alpha-skill')
    const payloadBytes = 256 * 1024
    await writeFile(join(source, 'payload.bin'), Buffer.alloc(payloadBytes, 0x61))
    const bundle = await createSkillBundleArchive({
      sources: [{ sourceDirectory: source }],
      archivePath: join(root, 'bundle.tar.gz'),
      packageId: 'package_mid_extract_cancel',
      versionId: 'version_mid_extract_cancel',
      bundleName: 'team-skills'
    })
    const destinationRoot = join(root, 'home', '.agents', 'skills')
    const controller = new AbortController()
    let observedPartialBytes = false
    const signal = new Proxy(controller.signal, {
      get(target, property) {
        if (property === 'aborted' && !target.aborted) {
          const extraction = readdirSync(destinationRoot, { withFileTypes: true }).find(
            (entry) => entry.isDirectory() && entry.name.startsWith('.orca-skill-extract-')
          )
          if (extraction) {
            const size = (() => {
              try {
                return statSync(
                  join(destinationRoot, extraction.name, 'skills', 'alpha-skill', 'payload.bin')
                ).size
              } catch {
                return 0
              }
            })()
            if (size > 0 && size < payloadBytes) {
              observedPartialBytes = true
              controller.abort()
            }
          }
        }
        const value = Reflect.get(target, property, target) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      }
    })

    await expect(
      installSkillBundle({
        operationId: 'operation_mid_extract_cancel',
        archivePath: bundle.archivePath,
        packageId: bundle.manifest.packageId,
        versionId: bundle.manifest.versionId,
        bundleDigest: bundle.manifest.bundleDigest,
        selectedSkillIds: ['alpha-skill'],
        expectedArchiveSha256: bundle.archiveSha256,
        scope: 'global',
        homeDirectory: join(root, 'home'),
        orcaStateDirectory: join(root, 'state'),
        detectedProviders: [],
        destinationIdentity: 'local-global',
        hostIdentity: 'host_1',
        signal
      })
    ).rejects.toMatchObject({ data: SKILL_INSTALL_CANCELLED_FAILURE })

    expect(observedPartialBytes).toBe(true)
    await expect(readdir(destinationRoot)).resolves.toEqual([])
    await expect(
      readdir(join(root, 'state', 'skill-installs', 'extraction-journals'))
    ).resolves.toEqual([])
    await expect(listManagedSkillInstalls(join(root, 'state', 'skill-installs'))).resolves.toEqual(
      []
    )
  })

  it('installs a selected subset and keeps an unowned conflict local', async () => {
    const root = await temporaryDirectory()
    const alpha = await createSkill(join(root, 'sources'), 'alpha-skill')
    const beta = await createSkill(join(root, 'sources'), 'beta-skill')
    const homeDirectory = join(root, 'home')
    const existingBeta = join(homeDirectory, '.agents', 'skills', 'beta-skill')
    await mkdir(existingBeta, { recursive: true })
    await writeFile(
      join(existingBeta, 'SKILL.md'),
      '---\nname: beta-skill\ndescription: Local\n---\n\n# Keep me\n'
    )
    const bundle = await createSkillBundleArchive({
      sources: [{ sourceDirectory: alpha }, { sourceDirectory: beta }],
      archivePath: join(root, 'bundle.tar.gz'),
      packageId: 'package_1',
      versionId: 'version_1',
      bundleName: 'team-skills',
      createdAt: '2026-08-11T12:00:00.000Z'
    })

    const onProgress = vi.fn((progress: { skillIndex: number }) => {
      if (progress.skillIndex === 1) {
        throw new Error('renderer closed')
      }
    })
    const result = await installSkillBundle({
      operationId: 'operation_1',
      archivePath: bundle.archivePath,
      packageId: bundle.manifest.packageId,
      versionId: bundle.manifest.versionId,
      bundleDigest: bundle.manifest.bundleDigest,
      selectedSkillIds: ['alpha-skill', 'beta-skill'],
      expectedArchiveSha256: bundle.archiveSha256,
      scope: 'global',
      homeDirectory,
      orcaStateDirectory: join(root, 'state'),
      detectedProviders: [],
      destinationIdentity: 'local-global',
      hostIdentity: 'host_1',
      onProgress
    })

    expect(result.status).toBe('partial')
    expect(result.skills.map((skill) => [skill.name, skill.status])).toEqual([
      ['alpha-skill', 'installed'],
      ['beta-skill', 'kept-local']
    ])
    expect(onProgress.mock.calls.map(([progress]) => progress)).toEqual([
      {
        operationId: 'operation_1',
        skillId: 'alpha-skill',
        skillName: 'alpha-skill',
        skillIndex: 1,
        skillCount: 2
      },
      {
        operationId: 'operation_1',
        skillId: 'beta-skill',
        skillName: 'beta-skill',
        skillIndex: 2,
        skillCount: 2
      }
    ])
    expect(
      await readFile(join(homeDirectory, '.agents', 'skills', 'alpha-skill', 'SKILL.md'), 'utf8')
    ).toContain('# alpha-skill')
    expect(await readFile(join(existingBeta, 'SKILL.md'), 'utf8')).toContain('# Keep me')
    await expect(listManagedSkillInstalls(join(root, 'state', 'skill-installs'))).resolves.toEqual([
      expect.objectContaining({
        name: 'alpha-skill',
        packageId: 'package_1',
        versionId: 'version_1',
        bundleDigest: bundle.manifest.bundleDigest
      })
    ])
  })

  it('reports partial when a selected provider placement is unowned', async () => {
    const root = await temporaryDirectory()
    const alpha = await createSkill(join(root, 'sources'), 'alpha-skill')
    const homeDirectory = join(root, 'home')
    const providerPath = join(homeDirectory, '.claude', 'skills', 'alpha-skill')
    await mkdir(providerPath, { recursive: true })
    await writeFile(join(providerPath, 'SKILL.md'), '# Unowned')
    const bundle = await createSkillBundleArchive({
      sources: [{ sourceDirectory: alpha }],
      archivePath: join(root, 'bundle.tar.gz'),
      packageId: 'package_provider_partial',
      versionId: 'version_1',
      bundleName: 'team-skills'
    })

    const result = await installSkillBundle({
      operationId: 'operation_provider_partial',
      archivePath: bundle.archivePath,
      packageId: bundle.manifest.packageId,
      versionId: bundle.manifest.versionId,
      bundleDigest: bundle.manifest.bundleDigest,
      selectedSkillIds: ['alpha-skill'],
      expectedArchiveSha256: bundle.archiveSha256,
      scope: 'global',
      homeDirectory,
      orcaStateDirectory: join(root, 'state'),
      detectedProviders: ['claude'],
      destinationIdentity: 'local-global',
      hostIdentity: 'host_1'
    })

    expect(result).toMatchObject({
      status: 'partial',
      skills: [
        {
          name: 'alpha-skill',
          status: 'installed',
          placements: expect.arrayContaining([
            expect.objectContaining({ provider: 'claude', status: 'skipped' })
          ])
        }
      ]
    })

    await rm(providerPath, { recursive: true })
    const retried = await installSkillBundle({
      operationId: 'operation_provider_retry',
      archivePath: bundle.archivePath,
      packageId: bundle.manifest.packageId,
      versionId: bundle.manifest.versionId,
      bundleDigest: bundle.manifest.bundleDigest,
      selectedSkillIds: ['alpha-skill'],
      expectedArchiveSha256: bundle.archiveSha256,
      scope: 'global',
      homeDirectory,
      orcaStateDirectory: join(root, 'state'),
      detectedProviders: ['claude'],
      destinationIdentity: 'local-global',
      hostIdentity: 'host_1'
    })

    expect(retried).toMatchObject({
      status: 'complete',
      skills: [
        {
          name: 'alpha-skill',
          status: 'unchanged',
          placements: expect.arrayContaining([
            expect.objectContaining({ provider: 'claude', status: 'unchanged' })
          ])
        }
      ]
    })
  })
})
