import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BUNDLED_SKILL_SOURCES } from './bundled-skill-sources'
import { bundledSkillTextDigest } from './classify'

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..')

describe('embedded bundled skill sources', () => {
  it('carry exactly the repo’s skills/*/SKILL.md, LF-normalised', async () => {
    const names = (await readdir(join(REPO_ROOT, 'skills'), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
    expect(BUNDLED_SKILL_SOURCES.map((source) => source.name)).toEqual(names)
    for (const source of BUNDLED_SKILL_SOURCES) {
      const onDisk = await readFile(join(REPO_ROOT, 'skills', source.name, 'SKILL.md'), 'utf8')
      expect(source.text).toBe(onDisk.replace(/\r\n?/gu, '\n'))
    }
  })

  it('list this build’s digest and agree with the released ledger', async () => {
    const ledger = JSON.parse(
      await readFile(join(REPO_ROOT, 'resources', 'skills', 'released-digests.json'), 'utf8')
    )
    for (const source of BUNDLED_SKILL_SOURCES) {
      expect(source.releasedDigests).toContain(bundledSkillTextDigest(Buffer.from(source.text)))
      expect(source.releasedDigests).toEqual(ledger.skills[source.name])
    }
  })
})
