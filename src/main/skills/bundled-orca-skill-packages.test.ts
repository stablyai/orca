import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BUNDLED_ORCA_SKILL_PACKAGES } from './bundled-orca-skill-packages'
import { bundledOrcaSkillManifest } from './bundled-orca-skill-install'

describe('embedded Orca skill packages', () => {
  it('install exactly the bytes the freshness manifest judges current', async () => {
    const manifest: { skills: { name: string; packageDigest: string }[] } = JSON.parse(
      await readFile(join(process.cwd(), 'resources', 'skills', 'current-manifest.json'), 'utf8')
    )

    expect(
      BUNDLED_ORCA_SKILL_PACKAGES.map((entry) => ({
        name: entry.name,
        packageDigest: bundledOrcaSkillManifest(entry).packageDigest
      }))
    ).toEqual(manifest.skills.map(({ name, packageDigest }) => ({ name, packageDigest })))
    for (const entry of BUNDLED_ORCA_SKILL_PACKAGES) {
      expect(entry.releasedDigests).toContain(bundledOrcaSkillManifest(entry).packageDigest)
    }
  })
})
