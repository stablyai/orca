import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AGENT_PLUGIN_SCHEMA_V1 } from '../../../shared/skill-bundle-manifest'
import { createSkillBundleArchive } from './skill-bundle-creation'
import { extractSkillBundleArchive } from './skill-bundle-extraction'
import '../package-archive/skill-package-tar'

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

  it('round trips a file whose name extends a sibling directory name', async () => {
    const root = await temporaryDirectory()
    const source = await createSkill(root, 'alpha-skill', 'Alpha')
    await mkdir(join(source, 'references', 'refs'), { recursive: true })
    await writeFile(join(source, 'references', 'refs.md'), 'reference\n')
    await writeFile(join(source, 'references', 'refs', 'image.webp'), Buffer.from([0, 1, 2]))
    const created = await createSkillBundleArchive({
      sources: [{ sourceDirectory: source }],
      archivePath: join(root, 'bundle.tar.gz'),
      packageId: 'package_1',
      versionId: 'version_1',
      bundleName: 'team-skills'
    })

    const extracted = await extractSkillBundleArchive({
      archivePath: created.archivePath,
      destinationDirectory: join(root, 'extracted'),
      expectedBundleDigest: created.manifest.bundleDigest
    })

    expect(extracted.manifest.skills[0].files.map((file) => file.path)).toEqual([
      'SKILL.md',
      'notes.txt',
      'references/refs.md',
      'references/refs/image.webp'
    ])
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
})
