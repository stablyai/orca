import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AGENT_PLUGIN_MANIFEST_PATH,
  AGENT_PLUGIN_SCHEMA_V1
} from '../../shared/skill-bundle-manifest'
import { createSkillBundleArchive } from './skill-bundle-creation'
import { extractSkillBundleArchive } from './skill-bundle-extraction'
import { writeSkillTarGzip } from './skill-package-tar'

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'orca-skill-bundle-test-'))
  temporaryDirectories.push(directory)
  return directory
}

async function createSkill(root: string, name: string, description: string): Promise<string> {
  const directory = join(root, name)
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`
  )
  await writeFile(join(directory, 'notes.txt'), `${name} notes\n`)
  return directory
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true }))
  )
})

describe('skill bundle creation and extraction', () => {
  it('verifies manifest executable paths without Windows mode bits', async () => {
    const root = await temporaryDirectory()
    const source = await createSkill(root, 'script-skill', 'Script')
    const script = join(source, 'run.sh')
    await writeFile(script, '#!/bin/sh\necho ok\n')
    await chmod(script, 0o700)
    const created = await createSkillBundleArchive({
      sources: [{ sourceDirectory: source }],
      archivePath: join(root, 'bundle.tar.gz'),
      packageId: 'package_windows',
      versionId: 'version_windows',
      bundleName: 'windows-bundle'
    })
    expect(created.manifest.skills[0].files).toContainEqual(
      expect.objectContaining({ path: 'run.sh', executable: true })
    )

    await expect(
      extractSkillBundleArchive({
        archivePath: created.archivePath,
        destinationDirectory: join(root, 'windows-extracted'),
        platform: 'win32'
      })
    ).resolves.toMatchObject({ manifest: { bundleName: 'windows-bundle' } })
  })

  it('round trips multiple skills through an Agent Plugins compatible root', async () => {
    const root = await temporaryDirectory()
    const alpha = await createSkill(root, 'alpha-skill', 'Alpha')
    const beta = await createSkill(root, 'beta-skill', 'Beta')
    const created = await createSkillBundleArchive({
      sources: [{ sourceDirectory: beta }, { sourceDirectory: alpha }],
      archivePath: join(root, 'bundle.tar.gz'),
      packageId: 'package_1',
      versionId: 'version_1',
      bundleName: 'team-skills',
      description: 'Team skills',
      createdAt: '2026-08-11T12:00:00.000Z'
    })

    const extracted = await extractSkillBundleArchive({
      archivePath: created.archivePath,
      destinationDirectory: join(root, 'extracted'),
      expectedBundleDigest: created.manifest.bundleDigest
    })

    expect(extracted.pluginManifest).toEqual({
      $schema: AGENT_PLUGIN_SCHEMA_V1,
      name: 'team-skills',
      version: 'version_1',
      description: 'Team skills'
    })
    expect(extracted.manifest.skills.map((skill) => skill.name)).toEqual([
      'alpha-skill',
      'beta-skill'
    ])
    expect(await readFile(join(extracted.skillsDirectory, 'beta-skill', 'notes.txt'), 'utf8')).toBe(
      'beta-skill notes\n'
    )
  })

  it('creates deterministic archives regardless of source selection order', async () => {
    const root = await temporaryDirectory()
    const alpha = await createSkill(root, 'alpha-skill', 'Alpha')
    const beta = await createSkill(root, 'beta-skill', 'Beta')
    const publication = {
      packageId: 'package_1',
      versionId: 'version_1',
      bundleName: 'team-skills',
      createdAt: '2026-08-11T12:00:00.000Z'
    }
    const first = await createSkillBundleArchive({
      ...publication,
      sources: [{ sourceDirectory: alpha }, { sourceDirectory: beta }],
      archivePath: join(root, 'first.tar.gz')
    })
    const second = await createSkillBundleArchive({
      ...publication,
      sources: [{ sourceDirectory: beta }, { sourceDirectory: alpha }],
      archivePath: join(root, 'second.tar.gz')
    })

    expect(first.archiveSha256).toBe(second.archiveSha256)
    expect(await readFile(first.archivePath)).toEqual(await readFile(second.archivePath))
  })

  it('packages and extracts thirty selected skills within the shared limits', async () => {
    const root = await temporaryDirectory()
    const names = Array.from(
      { length: 30 },
      (_, index) => `skill-${String(index).padStart(2, '0')}`
    )
    const sources = await Promise.all(
      names.map(async (name) => ({
        sourceDirectory: await createSkill(root, name, `Description for ${name}`)
      }))
    )
    const created = await createSkillBundleArchive({
      sources: sources.toReversed(),
      archivePath: join(root, 'thirty-skills.tar.gz'),
      packageId: 'package_30',
      versionId: 'version_30',
      bundleName: 'thirty-skills'
    })

    const extracted = await extractSkillBundleArchive({
      archivePath: created.archivePath,
      destinationDirectory: join(root, 'thirty-skills'),
      expectedBundleDigest: created.manifest.bundleDigest
    })

    expect(extracted.manifest.skills.map((skill) => skill.name)).toEqual(names)
    expect(extracted.manifest.skills).toHaveLength(30)
    await expect(
      readFile(join(extracted.skillsDirectory, 'skill-29', 'notes.txt'), 'utf8')
    ).resolves.toBe('skill-29 notes\n')
  })

  it('rejects conflicting staging roots without changing their imported namespace', async () => {
    const root = await temporaryDirectory()
    const source = await createSkill(root, 'alpha-skill', 'Alpha')
    const created = await createSkillBundleArchive({
      sources: [{ sourceDirectory: source }],
      archivePath: join(root, 'bundle.tar.gz'),
      packageId: 'package_1',
      versionId: 'version_1',
      bundleName: 'team-skills'
    })
    const destination = join(root, 'conflicting-staging')
    const importedManifest = join(destination, 'dev.orca.skill-sharing', 'manifest.json')
    await mkdir(join(destination, 'dev.orca.skill-sharing'), { recursive: true })
    await writeFile(importedManifest, 'unowned\n')

    await expect(
      extractSkillBundleArchive({
        archivePath: created.archivePath,
        destinationDirectory: destination
      })
    ).rejects.toMatchObject({ code: 'EEXIST' })
    await expect(readFile(importedManifest, 'utf8')).resolves.toBe('unowned\n')
  })

  it('rejects unknown top-level extension namespaces and removes fresh staging', async () => {
    const root = await temporaryDirectory()
    const plugin = Buffer.from(
      JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA_V1, name: 'team-skills' })
    )
    const unknown = Buffer.from('{}')
    const archivePath = join(root, 'unknown-extension.tar.gz')
    await writeSkillTarGzip(archivePath, [
      {
        path: AGENT_PLUGIN_MANIFEST_PATH,
        size: plugin.length,
        executable: false,
        bytes: plugin
      },
      {
        path: 'dev.orca.unexpected/manifest.json',
        size: unknown.length,
        executable: false,
        bytes: unknown
      }
    ])
    const destination = join(root, 'unknown-extension-staging')

    await expect(
      extractSkillBundleArchive({ archivePath, destinationDirectory: destination })
    ).rejects.toThrow('skill-bundle-manifest-envelope-invalid')
    await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects duplicate names and source drift without publishing an archive', async () => {
    const root = await temporaryDirectory()
    const first = await createSkill(root, 'same-skill', 'First')
    const secondRoot = join(root, 'other')
    const second = await createSkill(secondRoot, 'same-skill', 'Second')
    const archivePath = join(root, 'duplicate.tar.gz')

    await expect(
      createSkillBundleArchive({
        sources: [{ sourceDirectory: first }, { sourceDirectory: second }],
        archivePath,
        packageId: 'package_1',
        versionId: 'version_1',
        bundleName: 'team-skills'
      })
    ).rejects.toThrow('skill-bundle-skill-collision')
    await expect(readFile(archivePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
