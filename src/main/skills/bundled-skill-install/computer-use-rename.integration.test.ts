import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BUNDLED_SKILL_SOURCES } from './bundled-skill-sources'

import { makeSkillHome, removeSkillHomes, writeCopy } from './testing/bundled-skill-home'
import { clearSkillRootScanCache, discoverSkills } from '../discovery/skill-native-discovery'

const NAME = 'orca-computer-use'
const OLD = 'computer-use'
const FIXTURE = join(import.meta.dirname, 'computer-use-before-rename.skill-md.txt')
afterEach(async () => {
  clearSkillRootScanCache()
  await removeSkillHomes()
})

describe('released computer-use installation migration', () => {
  it('keeps a former package with user-added files visible alongside the new skill', async () => {
    const home = await makeSkillHome()
    const old = join(dirname(home.shared), OLD)
    await writeCopy(old, await readFile(FIXTURE, 'utf8'), { 'notes.md': 'My workflow' })
    const source = BUNDLED_SKILL_SOURCES.find((skill) => skill.name === NAME)
    if (!source) {
      throw new Error('Canonical skill is missing')
    }
    await writeCopy(join(dirname(home.shared), NAME), source.text)
    const result = await discoverSkills({
      homeDir: home.home,
      includeCwd: false,
      sourceKinds: ['home'],
      refresh: true
    })
    expect(result.skills.map((skill) => skill.name).sort()).toEqual([OLD, NAME])
    expect(await readFile(join(old, 'notes.md'), 'utf8')).toBe('My workflow')
  })
})
