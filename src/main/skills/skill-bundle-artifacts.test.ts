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
