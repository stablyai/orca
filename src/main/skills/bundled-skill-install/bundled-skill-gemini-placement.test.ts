import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { autoUpdateInstalledBundledSkills } from './bundled-skill-installation'
import {
  linkDirectory,
  makeSkillHome,
  NAME,
  NEW_SOURCE,
  NEW_TEXT,
  OLD_TEXT,
  previewAndInstall,
  removeSkillHomes,
  serviceInput,
  snapshot,
  writeCopy
} from './testing/bundled-skill-home'

const EDITED_TEXT = `---\nname: ${NAME}\n---\nmine\n`
const digestOf = (text: string) => createHash('sha256').update(text).digest('hex')
const geminiSkill = (home: string) => join(home, '.gemini', 'skills', NAME)

afterEach(removeSkillHomes)

// Gemini CLI loads ~/.gemini/skills and ~/.agents/skills and warns when both hold a skill name.
describe('Gemini CLI bundled skill placement', () => {
  it('installs only into ~/.agents/skills', async () => {
    const home = await makeSkillHome()
    await previewAndInstall(serviceInput(home, { agents: ['gemini'] }))
    expect(await snapshot(home.shared)).toBe(`dir[SKILL.md]:${NEW_TEXT}`)
    expect(await snapshot(geminiSkill(home.home))).toBe('missing')
  })

  it("silently retires Orca's former ~/.gemini/skills link and copy", async () => {
    const home = await makeSkillHome()
    await writeCopy(home.shared, NEW_TEXT)
    await mkdir(join(home.home, '.gemini', 'skills'), { recursive: true })
    await linkDirectory(home.shared, geminiSkill(home.home))
    const copied = await makeSkillHome()
    await writeCopy(copied.shared, OLD_TEXT)
    await writeCopy(geminiSkill(copied.home), OLD_TEXT)

    for (const target of [home, copied]) {
      await autoUpdateInstalledBundledSkills({
        ...serviceInput(target, { agents: ['gemini'] }),
        names: [NAME]
      })
      expect(await snapshot(target.shared)).toBe(`dir[SKILL.md]:${NEW_TEXT}`)
      expect(await snapshot(geminiSkill(target.home))).toBe('missing')
    }
  })

  it("retires Orca's copy left under a skill's former name", async () => {
    const home = await makeSkillHome()
    const formerText = OLD_TEXT.replace(`name: ${NAME}`, 'name: former-skill')
    await writeCopy(home.shared, NEW_TEXT)
    await writeCopy(join(home.home, '.gemini', 'skills', 'former-skill'), formerText)
    const source = {
      ...NEW_SOURCE,
      aliases: ['former-skill'],
      releasedDigests: [...NEW_SOURCE.releasedDigests, digestOf(formerText)]
    }
    await autoUpdateInstalledBundledSkills({
      ...serviceInput(home, { agents: ['gemini'] }),
      sources: [source],
      names: [NAME]
    })
    expect(await snapshot(join(home.home, '.gemini', 'skills', 'former-skill'))).toBe('missing')
  })

  it("leaves a user's edited ~/.gemini/skills folder alone", async () => {
    const home = await makeSkillHome()
    await writeCopy(home.shared, NEW_TEXT)
    await writeCopy(geminiSkill(home.home), EDITED_TEXT)
    await previewAndInstall(serviceInput(home, { agents: ['gemini'] }))
    expect(await snapshot(geminiSkill(home.home))).toBe(`dir[SKILL.md]:${EDITED_TEXT}`)
  })

  it("keeps another agent's link when ~/.gemini/skills links to that agent's folder", async () => {
    const home = await makeSkillHome()
    await writeCopy(home.shared, NEW_TEXT)
    await mkdir(dirname(home.claude), { recursive: true })
    await linkDirectory(home.shared, home.claude)
    await mkdir(join(home.home, '.gemini'))
    await linkDirectory(dirname(home.claude), join(home.home, '.gemini', 'skills'))
    await previewAndInstall(serviceInput(home, { agents: ['codex'] }))
    expect(await snapshot(home.claude)).toBe(`link:${home.shared}`)
  })
})
