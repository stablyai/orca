import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bundledSkillNudgeEntries } from '../../../shared/bundled-skill-summary'
import { BUNDLED_SKILL_SOURCES } from './bundled-skill-sources'
import { bundledSkillTextDigest } from './classify'
import { autoUpdateInstalledBundledSkills, previewBundledSkillInstall } from './service'
import {
  linkDirectory,
  makeSkillHome,
  removeSkillHomes,
  serviceInput,
  writeCopy,
  type SkillHome
} from './skill-home.test-support'

afterEach(removeSkillHomes)

// The first orchestration SKILL.md any release shipped (v1.3.24-rc.2), installed by `npx skills add`.
const OLDEST_FIXTURE = join(import.meta.dirname, 'orchestration-v1.3.24-rc.2.skill-md.txt')
const SOURCE = BUNDLED_SKILL_SOURCES.find((source) => source.name === 'orchestration')

function input(home: SkillHome) {
  if (!SOURCE) {
    throw new Error('orchestration is no longer bundled')
  }
  return { ...serviceInput(home, { installedOnly: true }), sources: [SOURCE] }
}

const orchestrationIn = (home: SkillHome, root: 'shared' | 'claude') =>
  join(dirname(home[root]), 'orchestration')

describe('skills installed by much older Orca versions', () => {
  it('recognizes the oldest shipped orchestration as unedited', async () => {
    const oldest = await readFile(OLDEST_FIXTURE)
    expect(SOURCE?.releasedDigests).toContain(bundledSkillTextDigest(oldest))
  })

  it('silently updates the npx-skills layout: shared copy plus agent link', async () => {
    const home = await makeSkillHome()
    const shared = orchestrationIn(home, 'shared')
    await writeCopy(shared, await readFile(OLDEST_FIXTURE, 'utf8'))
    await mkdir(dirname(home.claude), { recursive: true })
    await linkDirectory(shared, orchestrationIn(home, 'claude'))

    const result = await autoUpdateInstalledBundledSkills({
      ...input(home),
      names: ['orchestration']
    })

    expect(result.skills[0]?.ops.map((op) => [op.kind, op.status])).toEqual([['update', 'done']])
    expect(await readFile(join(shared, 'SKILL.md'), 'utf8')).toBe(SOURCE?.text)
    expect((await lstat(orchestrationIn(home, 'claude'))).isSymbolicLink()).toBe(true)
    const claudeCopy = await readFile(join(orchestrationIn(home, 'claude'), 'SKILL.md'), 'utf8')
    expect(claudeCopy).toBe(SOURCE?.text)
    expect(bundledSkillNudgeEntries(await previewBundledSkillInstall(input(home)))).toEqual([])
  })

  it('silently updates a CRLF agent-folder copy with no shared copy', async () => {
    const home = await makeSkillHome()
    const claude = orchestrationIn(home, 'claude')
    await writeCopy(claude, (await readFile(OLDEST_FIXTURE, 'utf8')).replace(/\n/gu, '\r\n'))

    await autoUpdateInstalledBundledSkills({ ...input(home), names: ['orchestration'] })

    expect(await readFile(join(claude, 'SKILL.md'), 'utf8')).toBe(SOURCE?.text)
    expect(bundledSkillNudgeEntries(await previewBundledSkillInstall(input(home)))).toEqual([])
  })

  it('asks before touching an old copy the user added a file to', async () => {
    const home = await makeSkillHome()
    const shared = orchestrationIn(home, 'shared')
    await writeCopy(shared, await readFile(OLDEST_FIXTURE, 'utf8'))
    await writeFile(join(shared, 'my-notes.md'), 'mine')

    const result = await autoUpdateInstalledBundledSkills({
      ...input(home),
      names: ['orchestration']
    })

    expect(result.skills).toEqual([])
    expect(await readFile(join(shared, 'SKILL.md'))).toEqual(await readFile(OLDEST_FIXTURE))
    const plan = await previewBundledSkillInstall(input(home))
    expect(plan.skills[0]?.ops[0]).toMatchObject({ kind: 'leave', reason: 'edited' })
    expect(bundledSkillNudgeEntries(plan).map((entry) => entry.name)).toEqual(['orchestration'])
  })
})
