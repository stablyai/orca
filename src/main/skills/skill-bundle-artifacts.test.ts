import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadSkillBundleArtifacts } from './skill-bundle-artifacts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((root) => rm(root, { recursive: true })))
})

describe('skill bundle artifacts', () => {
  it('loads the committed schema-2 artifacts and rejects a stamped schema-1 manifest', async () => {
    const resourceRoot = await mkdtemp(join(tmpdir(), 'orca-skill-artifacts-'))
    temporaryDirectories.push(resourceRoot)
    const target = join(resourceRoot, 'skills')
    const source = resolve('resources', 'skills')
    await mkdir(target, { recursive: true })
    const [manifest, registry, releaseMapping] = await Promise.all(
      ['current-manifest.json', 'snapshot-registry.json', 'release-mapping.json'].map((name) =>
        readFile(join(source, name), 'utf8')
      )
    )
    await Promise.all([
      writeFile(join(target, 'current-manifest.json'), manifest),
      writeFile(join(target, 'snapshot-registry.json'), registry),
      writeFile(join(target, 'release-mapping.json'), releaseMapping)
    ])

    const artifacts = await loadSkillBundleArtifacts(resourceRoot)
    expect(artifacts.manifest.schemaVersion).toBe(2)
    expect(artifacts.manifest.skills.length).toBeGreaterThan(0)

    const legacyRoot = await mkdtemp(join(tmpdir(), 'orca-skill-artifacts-'))
    temporaryDirectories.push(legacyRoot)
    const legacyTarget = join(legacyRoot, 'skills')
    await mkdir(legacyTarget, { recursive: true })
    const legacyManifest = JSON.parse(manifest)
    legacyManifest.schemaVersion = 1
    legacyManifest.appVersion = '1.0.0'
    for (const skill of legacyManifest.skills) {
      skill.appVersion = '1.0.0'
    }
    await Promise.all([
      writeFile(join(legacyTarget, 'current-manifest.json'), JSON.stringify(legacyManifest)),
      writeFile(join(legacyTarget, 'snapshot-registry.json'), registry),
      writeFile(join(legacyTarget, 'release-mapping.json'), releaseMapping)
    ])

    await expect(loadSkillBundleArtifacts(legacyRoot)).rejects.toThrow(
      'Invalid skill bundle manifest'
    )
  })

  it('rejects malformed nested release entries before building provenance', async () => {
    const resourceRoot = await mkdtemp(join(tmpdir(), 'orca-skill-artifacts-'))
    temporaryDirectories.push(resourceRoot)
    const target = join(resourceRoot, 'skills')
    const source = resolve('resources', 'skills')
    await mkdir(target, { recursive: true })
    const [manifest, registry, releaseMapping] = await Promise.all(
      ['current-manifest.json', 'snapshot-registry.json', 'release-mapping.json'].map((name) =>
        readFile(join(source, name), 'utf8')
      )
    )
    const malformedMapping = JSON.parse(releaseMapping)
    malformedMapping.releases[0] = { appVersion: 'invalid' }
    await Promise.all([
      writeFile(join(target, 'current-manifest.json'), manifest),
      writeFile(join(target, 'snapshot-registry.json'), registry),
      writeFile(join(target, 'release-mapping.json'), JSON.stringify(malformedMapping))
    ])

    await expect(loadSkillBundleArtifacts(resourceRoot)).rejects.toThrow(
      'Invalid skill release mapping'
    )
  })
})
