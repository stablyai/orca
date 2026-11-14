import { createHash } from 'node:crypto'
import { appendFile, lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  bundledSkillInstallAction,
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

const DEV_TEXT = `---\nname: ${NAME}\ndescription: Dev\n---\n\nDev branch body\n`
/** A dev build whose bundle never shipped `NEW_TEXT`, so it cannot recognise that copy by hash. */
const DEV_SOURCE: BundledSkillSource = {
  name: NAME,
  text: DEV_TEXT,
  releasedDigests: [digest(OLD_TEXT), digest(DEV_TEXT)]
}

const asBuild = (home: SkillHome, source: BundledSkillSource) => ({
  ...serviceInput(home),
  sources: [source]
})
const autoUpdateAs = (home: SkillHome, source: BundledSkillSource) =>
  autoUpdateInstalledBundledSkills({ ...asBuild(home, source), names: [NAME] })
const hasMarker = (home: SkillHome, text: string) =>
  lstat(join(home.home, '.agents', '.orca-skill-digests', NAME, digest(text))).then(
    () => true,
    () => false
  )

describe("another Orca build's copy on the same host", () => {
  it('links a newly selected agent to a recognized shared copy', async () => {
    const home = await makeSkillHome()
    await writeCopy(home.shared, NEWER_TEXT)
    await autoUpdateAs(home, NEWER_SOURCE)

    const input = { ...serviceInput(home, { agents: ['cursor'] }), sources: [NEW_SOURCE] }
    await previewAndInstall(input)

    expect((await lstat(home.cursor)).isSymbolicLink()).toBe(true)
    expect(await readFile(join(home.cursor, 'SKILL.md'), 'utf8')).toBe(NEWER_TEXT)
  })

  it('automatically migrates a former-name agent copy to a recognized shared copy', async () => {
    const home = await makeSkillHome()
    await writeCopy(home.shared, NEWER_TEXT)
    await autoUpdateAs(home, NEWER_SOURCE)
    await writeCopy(join(home.home, '.claude', 'skills', 'former-test-skill'), OLD_TEXT)

    await autoUpdateAs(home, { ...NEW_SOURCE, aliases: ['former-test-skill'] })

    expect((await lstat(home.claude)).isSymbolicLink()).toBe(true)
    expect(await readFile(join(home.claude, 'SKILL.md'), 'utf8')).toBe(NEWER_TEXT)
  })

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
    // Replacing it may downgrade it, so the dialog and setup button never offer to.
    expect(plan.skills[0].ops[0].replaceable).toBe(false)
    // Setup counts it as installed: nothing to run, replace or fix.
    expect(bundledSkillInstallAction(plan)).toEqual({ kind: 'none' })
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

  it("marks a copy already at the build's own digest when its keep-only update runs", async () => {
    const home = await makeSkillHome()
    // Written before markers existed; the build that owns these bytes sees it as current.
    await writeCopy(home.shared, NEW_TEXT)
    expect(await hasMarker(home, NEW_TEXT)).toBe(false)

    const result = await autoUpdateAs(home, NEW_SOURCE)
    expect(result.skills).toEqual([])
    expect(await hasMarker(home, NEW_TEXT)).toBe(true)

    const plan = await previewBundledSkillInstall(asBuild(home, DEV_SOURCE))
    expect(plan.skills[0].ops[0]).toMatchObject({ kind: 'leave', reason: 'other-build' })
    expect(bundledSkillNudgeEntries(plan)).toEqual([])
  })

  it("is not reported out of date when another build installed it under the skill's former name", async () => {
    const home = await makeSkillHome()
    const FORMER_NAME = 'former-test-skill'
    const FORMER_DEV_TEXT = `---\nname: ${FORMER_NAME}\ndescription: Dev\n---\n\nFormer dev body\n`
    // A build from before the rename, whose text the renamed build never shipped.
    const formerBuild = asBuild(home, {
      name: FORMER_NAME,
      text: FORMER_DEV_TEXT,
      releasedDigests: [digest(FORMER_DEV_TEXT)]
    })
    await previewAndInstall(formerBuild)

    const renamed = asBuild(home, { ...NEW_SOURCE, aliases: [FORMER_NAME] })
    const plan = await previewBundledSkillInstall({ ...renamed, installedOnly: true })
    expect(plan.skills.flatMap((skill) => skill.ops.map((op) => op.reason))).not.toContain('edited')
    expect(bundledSkillNudgeEntries(plan)).toEqual([])

    // A user edit to that former-name copy is still asked about.
    await appendFile(join(home.home, '.agents', 'skills', FORMER_NAME, 'SKILL.md'), '\nmy note\n')
    const edited = await previewBundledSkillInstall({ ...renamed, installedOnly: true })
    expect(bundledSkillNudgeEntries(edited).map((entry) => entry.name)).toEqual([NAME])
  })

  it('records a current copy on a record-only request but never updates a released one', async () => {
    const home = await makeSkillHome()
    await writeCopy(home.shared, NEW_TEXT)
    const recordOnly = { ...asBuild(home, NEW_SOURCE), names: [NAME], recordOnly: true }

    expect((await autoUpdateInstalledBundledSkills(recordOnly)).skills).toEqual([])
    expect(await hasMarker(home, NEW_TEXT)).toBe(true)

    // A copy at an older release text would be silently updated, but not by a record-only request.
    await writeCopy(home.shared, OLD_TEXT)
    expect((await autoUpdateInstalledBundledSkills(recordOnly)).skills).toEqual([])
    expect(await readFile(join(home.shared, 'SKILL.md'), 'utf8')).toBe(OLD_TEXT)
    expect(await hasMarker(home, OLD_TEXT)).toBe(false)
  })

  it('writes no marker from a preview alone', async () => {
    const home = await makeSkillHome()
    await writeCopy(home.shared, NEW_TEXT)

    await previewBundledSkillInstall(asBuild(home, NEW_SOURCE))
    expect(await hasMarker(home, NEW_TEXT)).toBe(false)
    const plan = await previewBundledSkillInstall(asBuild(home, DEV_SOURCE))
    expect(plan.skills[0].ops[0]).toMatchObject({ kind: 'leave', reason: 'edited' })
  })

  it("records a paired server's marker on the server's own disk, never the client's", async () => {
    const client = await makeSkillHome()
    const server = await makeSkillHome()
    await writeCopy(client.shared, NEW_TEXT)
    await writeCopy(server.shared, NEW_TEXT)

    // The server runs its own keep-only update against its own home.
    await autoUpdateAs(server, NEW_SOURCE)
    expect(await hasMarker(server, NEW_TEXT)).toBe(true)
    expect(await hasMarker(client, NEW_TEXT)).toBe(false)

    const serverPlan = await previewBundledSkillInstall(asBuild(server, DEV_SOURCE))
    const clientPlan = await previewBundledSkillInstall(asBuild(client, DEV_SOURCE))
    expect(serverPlan.skills[0].ops[0]).toMatchObject({ reason: 'other-build' })
    expect(clientPlan.skills[0].ops[0]).toMatchObject({ reason: 'edited' })
  })
})
