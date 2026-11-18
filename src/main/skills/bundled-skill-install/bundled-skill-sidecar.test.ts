import { createHash } from 'node:crypto'
import { appendFile, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
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
  it("reads a current copy as current in the planned host's plan and records it as Orca's", async () => {
    // Paired and managed servers plan their own disk with this code; the client only summarizes.
    const host = await makeSkillHome()
    await writeCopy(host.shared, NEW_TEXT)
    await addSidecar(host.shared)

    const plan = await previewBundledSkillInstall(sharedOnly(host))
    expect(plan.skills[0].ops.map((op) => [op.kind, op.reason])).toEqual([['keep', undefined]])
    expect(summarizeBundledSkillPlan(plan).skills[0].upToDate).toBe(true)
    expect(bundledSkillNudgeKey('paired-server', plan)).toBeNull()

    await autoUpdateInstalledBundledSkills({ ...sharedOnly(host), names: [NAME], recordOnly: true })
    const marker = join(host.home, '.agents', '.orca-skill-digests', NAME, digest(NEW_TEXT))
    expect((await lstat(marker)).isDirectory()).toBe(true)
  })

  it('asks about an older released copy and never swaps it silently, even when Orca wrote it', async () => {
    const home = await makeSkillHome()
    // The older build that installed it recorded its bytes as Orca's.
    const olderBuild = { name: NAME, text: OLD_TEXT, releasedDigests: [digest(OLD_TEXT)] }
    await previewAndInstall({ ...serviceInput(home, { agents: [] }), sources: [olderBuild] })
    await addSidecar(home.shared)
    const before = await snapshot(home.shared)

    const result = await autoUpdateInstalledBundledSkills({ ...sharedOnly(home), names: [NAME] })

    expect(result.skills).toEqual([])
    expect(await snapshot(home.shared)).toBe(before)
    expect(await readFile(join(home.shared, SIDECAR), 'utf8')).toBe(SIDECAR_TEXT)
    const plan = await previewBundledSkillInstall(sharedOnly(home))
    expect(plan.skills[0].ops[0]).toMatchObject({ kind: 'leave', reason: 'edited' })
    expect(bundledSkillNudgeEntries(plan).map((entry) => entry.name)).toEqual([NAME])
  })

  it('still asks about an edited SKILL.md beside a sidecar', async () => {
    const home = await makeSkillHome()
    await writeCopy(home.shared, NEW_TEXT)
    await addSidecar(home.shared)
    await appendFile(join(home.shared, 'SKILL.md'), '\nmy note\n')

    const plan = await previewBundledSkillInstall(sharedOnly(home))
    expect(plan.skills[0].ops[0]).toMatchObject({ kind: 'leave', reason: 'edited' })
    expect(bundledSkillNudgeEntries(plan).map((entry) => entry.name)).toEqual([NAME])
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

    // Bytes this build never shipped that another Orca build recorded read as that build's copy.
    await writeFile(join(formerOf(home), 'SKILL.md'), unknown)
    await mkdir(join(home.home, '.agents', '.orca-skill-digests', FORMER_NAME, digest(unknown)), {
      recursive: true
    })
    expect(await formerReason()).toBe('other-build')
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

  it("treats a user's own former-name folder beside the current copy as theirs", async () => {
    const home = await makeSkillHome()
    await writeCopy(home.shared, NEW_TEXT)
    await addSidecar(home.shared)
    await writeCopy(formerOf(home), `${FORMER_TEXT}my own notes\n`)

    const plan = await previewBundledSkillInstall(sharedOnly(home, [RENAMED]))

    expect(plan.skills[0].ops.map((op) => [op.path, op.kind])).toEqual([[home.shared, 'keep']])
    expect(bundledSkillNudgeEntries(plan)).toEqual([])
  })

  it('leaves a cloud-installed folder with extra files to its package', async () => {
    const home = await makeSkillHome()
    await writeCopy(home.shared, NEW_TEXT)
    await addSidecar(home.shared)
    await mkdir(dirname(skillInstallReceiptPath(home.state, home.shared)), { recursive: true })
    await writeFile(skillInstallReceiptPath(home.state, home.shared), '{}')

    const plan = await previewBundledSkillInstall(serviceInput(home, { agents: [] }))

    expect(plan.skills[0].ops.map((op) => [op.kind, op.reason])).toEqual([['leave', 'other']])
  })
})
