import { createHash } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  bundledSkillNudgeEntries,
  bundledSkillNudgeKey,
  summarizeBundledSkillPlan
} from '../../../shared/skills/bundled/bundled-skill-summary'
import { skillInstallReceiptPath } from '../transaction-state/skill-install-provenance'
import type { BundledSkillSource } from './bundled-skill-sources'
import {
  nativeBundledSkillFilesystem,
  type BundledSkillFilesystem
} from './bundled-skill-filesystem'
import {
  autoUpdateInstalledBundledSkills,
  installBundledSkills,
  previewBundledSkillInstall
} from './bundled-skill-installation'
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
  writeCopy,
  type SkillHome
} from './testing/bundled-skill-home'

afterEach(removeSkillHomes)

const SIDECAR = join('agents', 'openai.yaml')
const SIDECAR_TEXT = 'policy:\n  allow_implicit_invocation: false\n'
const digest = (text: string) => createHash('sha256').update(text).digest('hex')

/** Codex keeps per-skill policy in `agents/openai.yaml` beside the skill's SKILL.md. */
async function addSidecar(path: string) {
  await mkdir(join(path, 'agents'))
  await writeFile(join(path, SIDECAR), SIDECAR_TEXT)
}

const FORMER_NAME = 'former-test-skill'
const FORMER_TEXT = `---\nname: ${FORMER_NAME}\ndescription: Old\n---\n\nOld body\n`
const RENAMED: BundledSkillSource = {
  ...NEW_SOURCE,
  aliases: [FORMER_NAME],
  releasedDigests: [...NEW_SOURCE.releasedDigests, digest(FORMER_TEXT)]
}
const formerOf = (home: SkillHome) => join(dirname(home.shared), FORMER_NAME)

const sharedOnly = (home: SkillHome, sources: BundledSkillSource[] = [NEW_SOURCE]) => ({
  ...serviceInput(home, { agents: [], installedOnly: true }),
  sources
})

describe('a bundled skill folder holding a file Orca does not ship', () => {
  it('judges a copy by its SKILL.md alone and only rewrites it with consent', async () => {
    // Paired and managed servers plan their own disk with this code; the client only summarizes.
    const host = await makeSkillHome()
    await writeCopy(host.shared, NEW_TEXT)
    await addSidecar(host.shared)
    const plan = () => previewBundledSkillInstall(sharedOnly(host))

    const current = await plan()
    expect(current.skills[0].ops.map((op) => [op.kind, op.reason])).toEqual([['keep', undefined]])
    expect(summarizeBundledSkillPlan(current).skills[0].upToDate).toBe(true)
    expect(bundledSkillNudgeKey('paired-server', current)).toBeNull()
    await autoUpdateInstalledBundledSkills({ ...sharedOnly(host), names: [NAME], recordOnly: true })
    const markers = join(host.home, '.agents', '.orca-skill-digests', NAME)
    expect((await lstat(join(markers, digest(NEW_TEXT)))).isDirectory()).toBe(true)

    // A cloud package's receipt keeps such a folder its package's, as for a SKILL.md-only one.
    const receipt = skillInstallReceiptPath(host.state, host.shared)
    await mkdir(dirname(receipt), { recursive: true })
    await writeFile(receipt, '{}')
    const explicit = await previewBundledSkillInstall(serviceInput(host, { agents: [] }))
    expect(explicit.skills[0].ops[0]).toMatchObject({ kind: 'leave', reason: 'other' })
    await rm(receipt)

    // An older release Orca wrote is still offered as an update, never swapped silently.
    await writeFile(join(host.shared, 'SKILL.md'), OLD_TEXT)
    await mkdir(join(markers, digest(OLD_TEXT)), { recursive: true })
    const before = await snapshot(host.shared)
    expect(
      (await autoUpdateInstalledBundledSkills({ ...sharedOnly(host), names: [NAME] })).skills
    ).toEqual([])
    expect(await snapshot(host.shared)).toBe(before)
    expect(await readFile(join(host.shared, SIDECAR), 'utf8')).toBe(SIDECAR_TEXT)
    const older = await plan()
    expect(older.skills[0].ops[0]).toMatchObject({ kind: 'leave', reason: 'edited' })
    expect(bundledSkillNudgeEntries(older).map((entry) => entry.name)).toEqual([NAME])

    await writeFile(join(host.shared, 'SKILL.md'), `${NEW_TEXT}\nmy note\n`)
    const edited = await plan()
    expect(edited.skills[0].ops[0]).toMatchObject({ kind: 'leave', reason: 'edited' })
    expect(bundledSkillNudgeEntries(edited).map((entry) => entry.name)).toEqual([NAME])
  })

  it('retires a former-name copy beside a current one without dropping its sidecar', async () => {
    const home = await makeSkillHome()
    const formerPath = formerOf(home)
    await writeCopy(formerPath, FORMER_TEXT)
    await writeCopy(home.shared, NEW_TEXT)
    await addSidecar(home.shared)

    await autoUpdateInstalledBundledSkills({ ...sharedOnly(home, [RENAMED]), names: [NAME] })

    expect(await snapshot(formerPath)).not.toMatch(/^dir/u)
    expect(await readFile(join(home.shared, 'SKILL.md'), 'utf8')).toBe(NEW_TEXT)
    expect(await readFile(join(home.shared, SIDECAR), 'utf8')).toBe(SIDECAR_TEXT)
    // Orca's own forward link at the former name is settled, not a different skill using it.
    for (const installedOnly of [true, false]) {
      const again = await previewBundledSkillInstall({
        ...serviceInput(home, { agents: [], installedOnly }),
        sources: [RENAMED]
      })
      expect(again.skills[0].ops.map((op) => [op.path, op.kind])).toEqual([[home.shared, 'keep']])
      expect(summarizeBundledSkillPlan(again).skills[0].upToDate).toBe(true)
    }
  })

  it.each([
    ['only SKILL.md', false],
    ['a sidecar', true]
  ])(
    'reports a retirement done when a former-name sibling is recovered after it (%s)',
    async (_, sidecar) => {
      const home = await makeSkillHome()
      await writeCopy(home.shared, NEW_TEXT)
      if (sidecar) {
        await addSidecar(home.shared)
      }
      await writeCopy(formerOf(home), FORMER_TEXT)
      const sibling = join(dirname(home.shared), `.${FORMER_NAME}.orca-old-interrupted`)
      await writeCopy(sibling, FORMER_TEXT)
      const input = { ...serviceInput(home, { agents: [] }), sources: [RENAMED] }

      const plan = await previewBundledSkillInstall(input)
      const result = await installBundledSkills(input, plan.planDigest)

      expect(result.skills[0].ops.map((op) => op.status)).toEqual(
        result.skills[0].ops.map(() => 'done')
      )
      expect(await snapshot(formerOf(home))).not.toMatch(/^dir/u)
      expect(await snapshot(sibling)).toBe('missing')
    }
  )

  it('does not flag a current copy with a sidecar for an unrelated folder at the former name', async () => {
    const home = await makeSkillHome()
    await writeCopy(home.shared, NEW_TEXT)
    await addSidecar(home.shared)
    const unrelated = '---\nname: my-own-tool\ndescription: Mine\n---\n\nMine\n'
    await writeCopy(formerOf(home), unrelated)

    for (const installedOnly of [true, false]) {
      const plan = await previewBundledSkillInstall({
        ...serviceInput(home, { agents: [], installedOnly }),
        sources: [RENAMED]
      })
      expect(plan.skills[0].ops.map((op) => [op.path, op.kind])).toEqual([[home.shared, 'keep']])
      expect(summarizeBundledSkillPlan(plan).skills[0].upToDate).toBe(true)
      expect(bundledSkillNudgeEntries(plan)).toEqual([])
    }
    expect(await readFile(join(formerOf(home), 'SKILL.md'), 'utf8')).toBe(unrelated)
  })

  it('re-checks the current copy before retiring a former-name copy into it', async () => {
    const home = await makeSkillHome()
    await writeCopy(formerOf(home), FORMER_TEXT)
    await writeCopy(home.shared, NEW_TEXT)
    await addSidecar(home.shared)
    // SKILL.md disappears after Orca observed it but before the former copy is retired.
    const racing: BundledSkillFilesystem = {
      ...nativeBundledSkillFilesystem,
      canWrite: async (directory) => {
        await rm(join(home.shared, 'SKILL.md'), { force: true })
        return nativeBundledSkillFilesystem.canWrite(directory)
      }
    }

    const result = await autoUpdateInstalledBundledSkills({
      ...sharedOnly(home, [RENAMED]),
      filesystem: racing,
      names: [NAME]
    })

    expect(result.skills[0].ops.map((op) => [op.kind, op.status])).toEqual([['keep', 'changed']])
    expect(await readFile(join(formerOf(home), 'SKILL.md'), 'utf8')).toBe(FORMER_TEXT)
  })

  it.each([
    ['installed-only', true],
    ['explicit', false]
  ])('keeps asking about a former-name copy with a sidecar (%s plan)', async (_, installedOnly) => {
    const home = await makeSkillHome()
    const unknown = `${FORMER_TEXT}another build\n`
    await writeCopy(formerOf(home), FORMER_TEXT)
    await addSidecar(formerOf(home))
    const input = { ...serviceInput(home, { agents: [], installedOnly }), sources: [RENAMED] }
    const formerReason = async () =>
      (await previewBundledSkillInstall(input)).skills[0].ops.find(
        (op) => op.path === formerOf(home)
      )?.reason

    expect(await formerReason()).toBe('edited')

    await writeCopy(home.shared, NEW_TEXT)
    await addSidecar(home.shared)
    const besideCurrent = await previewBundledSkillInstall(input)
    expect(besideCurrent.skills[0].ops.map((op) => [op.path, op.kind, op.reason])).toEqual([
      [home.shared, 'keep', undefined],
      [formerOf(home), 'leave', 'edited']
    ])
    expect(bundledSkillNudgeEntries(besideCurrent).map((entry) => entry.name)).toEqual([NAME])
    await autoUpdateInstalledBundledSkills({ ...input, names: [NAME] })
    expect(await readFile(join(formerOf(home), 'SKILL.md'), 'utf8')).toBe(FORMER_TEXT)
    expect(await readFile(join(formerOf(home), SIDECAR), 'utf8')).toBe(SIDECAR_TEXT)
    expect(
      bundledSkillNudgeEntries(await previewBundledSkillInstall(input)).map((entry) => entry.name)
    ).toEqual([NAME])

    // Bytes this build never shipped that another Orca build recorded read as that build's copy.
    await writeFile(join(formerOf(home), 'SKILL.md'), unknown)
    await mkdir(join(home.home, '.agents', '.orca-skill-digests', FORMER_NAME, digest(unknown)), {
      recursive: true
    })
    expect(await formerReason()).toBe('other-build')
  })

  it.each([
    ['installed-only', 'current', true],
    ['explicit', 'current', false],
    ['installed-only', 'other-build', true],
    ['explicit', 'other-build', false]
  ] as const)(
    "keeps asking about an agent's former-name copy beside a link into a shared copy with a sidecar (%s plan, %s shared)",
    async (_, shared, installedOnly) => {
      const home = await makeSkillHome()
      const sharedText = shared === 'current' ? NEW_TEXT : `${NEW_TEXT}another build\n`
      await writeCopy(home.shared, sharedText)
      await addSidecar(home.shared)
      if (shared === 'other-build') {
        const marker = join(home.home, '.agents', '.orca-skill-digests', NAME, digest(sharedText))
        await mkdir(marker, { recursive: true })
      }
      await mkdir(dirname(home.claude), { recursive: true })
      await linkDirectory(home.shared, home.claude)
      const formerAgentCopy = join(dirname(home.claude), FORMER_NAME)
      await writeCopy(formerAgentCopy, FORMER_TEXT)
      await addSidecar(formerAgentCopy)

      const plan = await previewBundledSkillInstall({
        ...serviceInput(home, { installedOnly }),
        sources: [RENAMED]
      })
      expect(plan.skills[0].ops.map((op) => [op.path, op.kind, op.reason])).toEqual([
        shared === 'current'
          ? [home.shared, 'keep', undefined]
          : [home.shared, 'leave', 'other-build'],
        [home.claude, 'keep', undefined],
        [formerAgentCopy, 'leave', 'edited']
      ])
      expect(bundledSkillNudgeEntries(plan).map((entry) => entry.name)).toEqual([NAME])
    }
  )

  it.each([
    ['installed-only', true],
    ['explicit', false]
  ])(
    "does not list an agent's former-name copy beside a link into a SKILL.md-only shared copy (%s plan)",
    async (_, installedOnly) => {
      const home = await makeSkillHome()
      await writeCopy(home.shared, NEW_TEXT)
      await mkdir(dirname(home.claude), { recursive: true })
      await linkDirectory(home.shared, home.claude)
      const formerAgentCopy = join(dirname(home.claude), FORMER_NAME)
      await writeCopy(formerAgentCopy, FORMER_TEXT)
      await addSidecar(formerAgentCopy)

      const plan = await previewBundledSkillInstall({
        ...serviceInput(home, { installedOnly }),
        sources: [RENAMED]
      })
      expect(plan.skills[0].ops.map((op) => [op.path, op.kind])).toEqual([
        [home.shared, 'keep'],
        [home.claude, 'keep']
      ])
      expect(bundledSkillNudgeEntries(plan)).toEqual([])
      expect(await readFile(join(formerAgentCopy, SIDECAR), 'utf8')).toBe(SIDECAR_TEXT)
    }
  )

  it('waits for consent when retiring an agent copy depends on backing up an edited sibling', async () => {
    for (const sidecar of [false, true]) {
      const home = await makeSkillHome()
      await writeCopy(home.shared, NEW_TEXT)
      if (sidecar) {
        await addSidecar(home.shared)
      }
      const interrupted = join(dirname(home.shared), `.${NAME}.orca-old-interrupted`)
      const edited = `${NEW_TEXT}my interrupted edit\n`
      await writeCopy(interrupted, edited)
      await mkdir(dirname(home.claude), { recursive: true })
      await linkDirectory(home.shared, home.claude)
      const former = join(dirname(home.claude), FORMER_NAME)
      await writeCopy(former, FORMER_TEXT)
      const input = { ...serviceInput(home, { installedOnly: true }), sources: [RENAMED] }

      const before = await previewBundledSkillInstall(input)
      expect(before.skills[0].ops[0]).toMatchObject({ kind: 'keep' })
      await autoUpdateInstalledBundledSkills({ ...input, names: [NAME] })

      expect(await readFile(join(interrupted, 'SKILL.md'), 'utf8')).toBe(edited)
      expect((await lstat(former)).isDirectory()).toBe(true)
      expect(await readFile(join(former, 'SKILL.md'), 'utf8')).toBe(FORMER_TEXT)
      expect(
        bundledSkillNudgeEntries(await previewBundledSkillInstall(input)).map((entry) => entry.name)
      ).toEqual([NAME])
    }
  })

  it('backs up the edited sibling, then retires the agent copy, when the user runs the update', async () => {
    for (const sidecar of [false, true]) {
      const home = await makeSkillHome()
      await writeCopy(home.shared, NEW_TEXT)
      if (sidecar) {
        await addSidecar(home.shared)
      }
      const interrupted = join(dirname(home.shared), `.${NAME}.orca-old-interrupted`)
      const edited = `${NEW_TEXT}my interrupted edit\n`
      await writeCopy(interrupted, edited)
      await mkdir(dirname(home.claude), { recursive: true })
      await linkDirectory(home.shared, home.claude)
      const former = join(dirname(home.claude), FORMER_NAME)
      await writeCopy(former, FORMER_TEXT)
      const input = { ...serviceInput(home, { installedOnly: true }), sources: [RENAMED] }

      const plan = await previewBundledSkillInstall(input)
      const result = await installBundledSkills(input, plan.planDigest)

      expect(result.skills[0].ops.map((op) => [op.path, op.kind, op.status])).toEqual([
        [home.shared, 'keep', 'done'],
        [home.claude, 'keep', 'done']
      ])
      const backups = join(home.home, '.agents', '.orca-skill-backups')
      const [backup, ...others] = await readdir(backups)
      expect(others).toEqual([])
      expect(await readFile(join(backups, backup, 'SKILL.md'), 'utf8')).toBe(edited)
      expect(await snapshot(interrupted)).toBe('missing')
      expect(await snapshot(former)).not.toMatch(/^dir/u)
      expect(await readFile(join(home.claude, 'SKILL.md'), 'utf8')).toBe(NEW_TEXT)
      const again = await previewBundledSkillInstall(input)
      expect(again.skills[0].ops.map((op) => op.kind)).toEqual(['keep', 'keep'])
      expect(bundledSkillNudgeEntries(again)).toEqual([])
    }
  })

  it('links a selected agent to a current shared copy with a sidecar', async () => {
    const home = await makeSkillHome()
    await writeCopy(home.shared, NEW_TEXT)
    await addSidecar(home.shared)

    const { plan } = await previewAndInstall(serviceInput(home))

    expect(plan.skills[0].ops.map((op) => op.kind)).toEqual(['keep', 'link'])
    expect(await readFile(join(home.claude, SIDECAR), 'utf8')).toBe(SIDECAR_TEXT)
    const again = await previewBundledSkillInstall(serviceInput(home, { installedOnly: true }))
    expect(again.skills[0].ops.map((op) => op.kind)).toEqual(['keep', 'keep'])
    expect(bundledSkillNudgeEntries(again)).toEqual([])
  })

  it.each([
    ['silent', true],
    ['explicit', false]
  ])(
    "keeps an agent's former-name copy when the shared copy it links to changed (%s)",
    async (_, silent) => {
      const home = await makeSkillHome()
      await writeCopy(home.shared, NEW_TEXT)
      await addSidecar(home.shared)
      await mkdir(dirname(home.claude), { recursive: true })
      await linkDirectory(home.shared, home.claude)
      const formerAgentCopy = join(dirname(home.claude), FORMER_NAME)
      await writeCopy(formerAgentCopy, FORMER_TEXT)
      const input = { ...serviceInput(home, { installedOnly: true }), sources: [RENAMED] }
      const plan = await previewBundledSkillInstall(input)
      // Shared SKILL.md vanishes after the locked re-plan observed it, before execution.
      const racing: BundledSkillFilesystem = {
        ...nativeBundledSkillFilesystem,
        canWrite: async (directory) => {
          await rm(join(home.shared, 'SKILL.md'), { force: true })
          return nativeBundledSkillFilesystem.canWrite(directory)
        }
      }

      const result = silent
        ? await autoUpdateInstalledBundledSkills({ ...input, filesystem: racing, names: [NAME] })
        : await installBundledSkills({ ...input, filesystem: racing }, plan.planDigest)

      expect(result.skills[0].ops.map((op) => [op.kind, op.status])).toEqual([
        ['keep', 'changed'],
        ['keep', 'skipped']
      ])
      expect(await readFile(join(formerAgentCopy, 'SKILL.md'), 'utf8')).toBe(FORMER_TEXT)
    }
  )

  it('copies a current shared copy with a sidecar for an agent on a host without links', async () => {
    const home = await makeSkillHome()
    await writeCopy(home.shared, NEW_TEXT)
    await addSidecar(home.shared)
    const filesystem = { ...nativeBundledSkillFilesystem, supportsLinks: false }

    const { plan } = await previewAndInstall(serviceInput(home, { filesystem }))

    expect(plan.skills[0].ops.map((op) => op.kind)).toEqual(['keep', 'copy'])
    expect(await readFile(join(home.claude, 'SKILL.md'), 'utf8')).toBe(NEW_TEXT)
    const again = await previewBundledSkillInstall(
      serviceInput(home, { filesystem, installedOnly: true })
    )
    expect(again.skills[0].ops.map((op) => op.kind)).toEqual(['keep', 'keep'])
  })
})
