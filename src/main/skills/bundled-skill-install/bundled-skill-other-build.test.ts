import { createHash } from 'node:crypto'
import { appendFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  bundledSkillNudgeEntries,
  bundledSkillNudgeKey,
  bundledSkillPlanState
} from '../../../shared/bundled-skill-summary'
import type { BundledSkillSource } from './bundled-skill-sources'
import {
  autoUpdateInstalledBundledSkills,
  previewBundledSkillInstall
} from './bundled-skill-installation'
import {
  makeSkillHome,
  NAME,
  NEW_SOURCE,
  NEW_TEXT,
  OLD_TEXT,
  previewAndInstall,
  removeSkillHomes,
  serviceInput,
  writeCopy,
  type SkillHome
} from './testing/bundled-skill-home'

afterEach(removeSkillHomes)

const digest = (text: string) => createHash('sha256').update(text).digest('hex')
const NEWER_TEXT = `---\nname: ${NAME}\ndescription: Newer\n---\n\nNewer body\n`
/** A newer Orca build on the same host: it knows every older text, but no older build knows its text. */
const NEWER_SOURCE: BundledSkillSource = {
  name: NAME,
  text: NEWER_TEXT,
  releasedDigests: [digest(OLD_TEXT), digest(NEW_TEXT), digest(NEWER_TEXT)]
}

const asBuild = (home: SkillHome, source: BundledSkillSource) => ({
  ...serviceInput(home),
  sources: [source]
})

describe("another Orca build's copy on the same host", () => {
  it('is not reported out of date or downgraded by an older build, until the user edits it', async () => {
    const home = await makeSkillHome()
    await writeCopy(home.shared, OLD_TEXT)
    await previewAndInstall(asBuild(home, NEWER_SOURCE))

    const plan = await previewBundledSkillInstall(asBuild(home, NEW_SOURCE))
    expect(plan.skills[0].ops.map((op) => [op.kind, op.reason])).toEqual([
      ['leave', 'other-build'],
      // Claude's link into the shared copy is already right.
      ['keep', undefined]
    ])
    expect(bundledSkillPlanState(plan.skills[0])).toBe('current')
    expect(bundledSkillNudgeEntries(plan)).toEqual([])
    expect(bundledSkillNudgeKey('local', plan)).toBeNull()

    await autoUpdateInstalledBundledSkills({ ...asBuild(home, NEW_SOURCE), names: [NAME] })
    expect(await readFile(join(home.shared, 'SKILL.md'), 'utf8')).toBe(NEWER_TEXT)

    // The record lives on the planned host's home: the same bytes no Orca wrote elsewhere still count as an edit.
    const elsewhere = await makeSkillHome()
    await writeCopy(elsewhere.shared, NEWER_TEXT)
    const elsewherePlan = await previewBundledSkillInstall(asBuild(elsewhere, NEW_SOURCE))
    expect(elsewherePlan.skills[0].ops[0]).toMatchObject({ kind: 'leave', reason: 'edited' })

    await appendFile(join(home.shared, 'SKILL.md'), '\nmy note\n')
    const edited = await previewBundledSkillInstall(asBuild(home, NEW_SOURCE))
    expect(edited.skills[0].ops[0]).toMatchObject({ kind: 'leave', reason: 'edited' })
    expect(bundledSkillNudgeEntries(edited).map((entry) => entry.name)).toEqual([NAME])
  })
})
