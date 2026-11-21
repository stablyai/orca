import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bundledSkillInstallAction } from '../../../shared/skills/bundled/bundled-skill-summary'
import { nativeBundledSkillFilesystem } from './bundled-skill-filesystem'
import { previewBundledSkillInstall } from './bundled-skill-installation'
import { BUNDLED_SKILL_SOURCES } from './bundled-skill-sources'

import {
  linkDirectory,
  makeSkillHome,
  removeSkillHomes,
  serviceInput,
  writeCopy,
  type SkillHome
} from './testing/bundled-skill-home'
import { clearSkillRootScanCache, discoverSkills } from '../discovery/skill-native-discovery'

const NAME = 'orca-computer-use'
const OLD = 'computer-use'
const FIXTURE = join(import.meta.dirname, 'computer-use-before-rename.skill-md.txt')
async function installCurrent(home: SkillHome): Promise<void> {
  const source = BUNDLED_SKILL_SOURCES.find((skill) => skill.name === NAME)
  if (!source) {
    throw new Error('Canonical skill is missing')
  }
  const shared = join(dirname(home.shared), NAME)
  await writeCopy(shared, source.text)
  const claude = join(dirname(home.claude), NAME)
  await mkdir(dirname(claude), { recursive: true })
  await linkDirectory(shared, claude)
}

afterEach(async () => {
  clearSkillRootScanCache()
  await removeSkillHomes()
})

describe('released computer-use installation migration', () => {
  it('keeps a former package with user-added files visible without flagging the current skill', async () => {
    const home = await makeSkillHome()
    const old = join(dirname(home.shared), OLD)
    await writeCopy(old, await readFile(FIXTURE, 'utf8'), { 'notes.md': 'My workflow' })
    await installCurrent(home)
    const result = await discoverSkills({
      homeDir: home.home,
      includeCwd: false,
      sourceKinds: ['home'],
      refresh: true
    })
    expect(result.skills.map((skill) => skill.name).sort()).toEqual([OLD, NAME])
    expect(await readFile(join(old, 'notes.md'), 'utf8')).toBe('My workflow')
    const plan = await previewBundledSkillInstall({
      ...serviceInput(home),
      sources: BUNDLED_SKILL_SOURCES,
      names: [NAME]
    })
    expect(bundledSkillInstallAction(plan)).toEqual({ kind: 'none' })
  })

  it('still flags a released former copy Orca cannot retire beside the current skill', async () => {
    const home = await makeSkillHome()
    await writeCopy(join(dirname(home.shared), OLD), await readFile(FIXTURE, 'utf8'))
    await installCurrent(home)
    const plan = await previewBundledSkillInstall({
      ...serviceInput(home, {
        filesystem: { ...nativeBundledSkillFilesystem, canWrite: async () => false }
      }),
      sources: BUNDLED_SKILL_SOURCES,
      names: [NAME]
    })
    expect(bundledSkillInstallAction(plan)).toEqual({ kind: 'attention' })
  })
})
