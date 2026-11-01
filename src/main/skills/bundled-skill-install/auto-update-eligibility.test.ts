import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bundledSkillPlanAutoUpdates } from '../../../shared/bundled-skill-summary'
import { previewBundledSkillInstall } from './service'
import {
  makeSkillHome,
  NAME,
  NEW_TEXT,
  OLD_TEXT,
  previewAndInstall,
  removeSkillHomes,
  serviceInput,
  writeCopy
} from './skill-home.test-support'

afterEach(removeSkillHomes)

const EDITED_TEXT = OLD_TEXT.replace('Old body', 'My own notes')

describe('bundled skill auto-update eligibility', () => {
  it('auto-updates a legacy copy whose hash matches a shipped release in every agent root', async () => {
    const home = await makeSkillHome()
    await writeCopy(home.shared, OLD_TEXT)
    await writeCopy(home.claude, OLD_TEXT)
    await writeCopy(home.cursor, OLD_TEXT.replace(/\n/gu, '\r\n'))
    const input = serviceInput(home, { agents: ['claude', 'cursor'], installedOnly: true })

    const { plan } = await previewAndInstall(input)

    expect(bundledSkillPlanAutoUpdates(plan)).toBe(true)
    for (const path of [home.shared, home.claude, home.cursor]) {
      expect(await readFile(join(path, 'SKILL.md'), 'utf8')).toBe(NEW_TEXT)
    }
  })

  it.each([
    ['edited SKILL.md', EDITED_TEXT, {}],
    ['content no Orca build shipped', `---\nname: ${NAME}\n---\nnever shipped\n`, {}],
    ['an added file', OLD_TEXT, { 'notes.md': 'mine' }]
  ])('asks before replacing a copy with %s', async (_label, text, extra) => {
    const home = await makeSkillHome()
    await writeCopy(home.shared, text, extra)

    const plan = await previewBundledSkillInstall(serviceInput(home, { installedOnly: true }))

    expect(plan.skills[0].ops[0]).toMatchObject({ kind: 'leave', reason: 'edited' })
    expect(bundledSkillPlanAutoUpdates(plan)).toBe(false)
  })

  it('updates only the unedited location and keeps the edited one', async () => {
    const home = await makeSkillHome()
    await writeCopy(home.shared, OLD_TEXT)
    await writeCopy(home.claude, EDITED_TEXT)

    const { plan } = await previewAndInstall(serviceInput(home, { installedOnly: true }))

    expect(bundledSkillPlanAutoUpdates(plan)).toBe(true)
    expect(await readFile(join(home.shared, 'SKILL.md'), 'utf8')).toBe(NEW_TEXT)
    expect(await readFile(join(home.claude, 'SKILL.md'), 'utf8')).toBe(EDITED_TEXT)
  })
})
