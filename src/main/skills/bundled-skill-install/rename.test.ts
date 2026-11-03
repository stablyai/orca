import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { acquireSkillInstallLock, skillInstallLockPath } from '../skill-install-lock'
import { skillInstallReceiptPath } from '../skill-install-provenance'
import { skillInstallJournalPath } from '../skill-install-recovery'
import { nativeBundledSkillFilesystem } from './filesystem'
import {
  autoUpdateInstalledBundledSkills,
  installBundledSkills,
  previewBundledSkillInstall
} from './service'
import {
  linkDirectory,
  makeSkillHome,
  NAME,
  NEW_SOURCE,
  NEW_TEXT,
  previewAndInstall,
  removeSkillHomes,
  serviceInput,
  snapshot,
  writeCopy
} from './skill-home.test-support'

const FORMER_NAME = 'former-test-skill'
const FORMER_TEXT = `---\nname: ${FORMER_NAME}\ndescription: Old\n---\n\nOld body\n`
const SOURCE = {
  ...NEW_SOURCE,
  aliases: [FORMER_NAME],
  releasedDigests: [
    ...NEW_SOURCE.releasedDigests,
    createHash('sha256').update(FORMER_TEXT).digest('hex')
  ]
}
const former = (path: string) => join(dirname(path), FORMER_NAME)
const read = (path: string) => readFile(join(path, 'SKILL.md'), 'utf8').catch(() => null)

afterEach(removeSkillHomes)

describe('bundled skill rename', () => {
  it('migrates installed copies and selected links, preserving older custom-profile links', async () => {
    const home = await makeSkillHome()
    await writeCopy(former(home.shared), FORMER_TEXT.replace(/\n/gu, '\r\n'))
    await mkdir(dirname(home.claude), { recursive: true })
    await linkDirectory(relative(dirname(home.claude), former(home.shared)), former(home.claude))
    const unselected = join(home.home, 'former-custom-profile', 'skills', FORMER_NAME)
    await mkdir(dirname(unselected), { recursive: true })
    await linkDirectory(former(home.shared), unselected)
    const input = { ...serviceInput(home, { installedOnly: true }), sources: [SOURCE] }

    await previewAndInstall(input)

    expect(await read(home.shared)).toBe(NEW_TEXT)
    expect(await read(home.claude)).toBe(NEW_TEXT)
    expect(await snapshot(former(home.claude))).toBe('missing')
    expect(await read(unselected)).toBe(NEW_TEXT)
    expect(await snapshot(home.cursor)).toBe('missing')
    const again = await previewBundledSkillInstall(input)
    expect(again.skills.flatMap((skill) => skill.ops).every((op) => op.kind === 'keep')).toBe(true)
    expect(await read(unselected)).toBe(NEW_TEXT)
  })

  it('updates a former agent-only copy without adding shared or other agent installations', async () => {
    const home = await makeSkillHome()
    await writeCopy(former(home.claude), FORMER_TEXT)
    await autoUpdateInstalledBundledSkills({
      ...serviceInput(home, { agents: ['claude', 'cursor'], installedOnly: true }),
      sources: [SOURCE],
      names: [FORMER_NAME]
    })
    expect(await read(home.claude)).toBe(NEW_TEXT)
    expect(await snapshot(former(home.claude))).toBe('missing')
    expect(await snapshot(home.shared)).toBe('missing')
    expect(await snapshot(home.cursor)).toBe('missing')
  })

  it('supports copy-only hosts while retaining the former shared compatibility copy', async () => {
    const home = await makeSkillHome()
    await writeCopy(former(home.shared), FORMER_TEXT)
    await writeCopy(former(home.claude), FORMER_TEXT)
    await previewAndInstall({
      ...serviceInput(home, {
        installedOnly: true,
        filesystem: { ...nativeBundledSkillFilesystem, supportsLinks: false }
      }),
      sources: [SOURCE]
    })
    expect(await read(home.shared)).toBe(NEW_TEXT)
    expect(await read(former(home.shared))).toBe(FORMER_TEXT)
    expect(await read(home.claude)).toBe(NEW_TEXT)
    expect(await snapshot(former(home.claude))).toBe('missing')
  })

  it.each<{ body: string; extra: Record<string, string> }>([
    { body: `${FORMER_TEXT}\nUser edits\n`, extra: {} },
    { body: FORMER_TEXT, extra: { 'notes.md': 'User notes' } },
    { body: '---\nname: computer-use\n---\nAnother provider\n', extra: {} }
  ])('preserves edited or unrelated former copies: $body', async ({ body, extra }) => {
    const home = await makeSkillHome()
    await writeCopy(former(home.claude), body, extra)
    const before = await snapshot(former(home.claude))
    await autoUpdateInstalledBundledSkills({
      ...serviceInput(home, { installedOnly: true }),
      sources: [SOURCE],
      names: [NAME]
    })
    expect(await snapshot(former(home.claude))).toBe(before)
    expect(await snapshot(home.claude)).toBe('missing')
  })

  it('keeps the old installation when the canonical destination cannot be written, then resumes', async () => {
    const home = await makeSkillHome()
    await writeCopy(former(home.claude), FORMER_TEXT)
    const input = { ...serviceInput(home, { installedOnly: true }), sources: [SOURCE] }
    const filesystem = {
      ...nativeBundledSkillFilesystem,
      rename: async (from: string, to: string) => {
        if (to === home.claude) {
          throw Object.assign(new Error('denied'), { code: 'EACCES' })
        }
        await nativeBundledSkillFilesystem.rename(from, to)
      }
    }
    const failedInput = { ...input, filesystem }
    const plan = await previewBundledSkillInstall(failedInput)
    const result = await installBundledSkills(failedInput, plan.planDigest)
    expect(result.skills.flatMap((skill) => skill.ops).some((op) => op.status === 'failed')).toBe(
      true
    )
    expect(await read(former(home.claude))).toBe(FORMER_TEXT)
    await previewAndInstall(input)
    expect(await read(home.claude)).toBe(NEW_TEXT)
    expect(await snapshot(former(home.claude))).toBe('missing')
  })

  it('rejects a stale preview when the former copy was edited', async () => {
    const home = await makeSkillHome()
    await writeCopy(former(home.claude), FORMER_TEXT)
    const input = { ...serviceInput(home, { installedOnly: true }), sources: [SOURCE] }
    const plan = await previewBundledSkillInstall(input)
    await writeFile(join(former(home.claude), 'SKILL.md'), `${FORMER_TEXT}saved later`)
    const result = await installBundledSkills(input, plan.planDigest)
    expect(result.skills.map((skill) => skill.status)).toEqual(['changed'])
    expect(await read(former(home.claude))).toBe(`${FORMER_TEXT}saved later`)
    expect(await snapshot(home.claude)).toBe('missing')
  })

  it('does not replace a conflicting canonical skill, even during silent migration', async () => {
    const home = await makeSkillHome()
    await writeCopy(former(home.claude), FORMER_TEXT)
    const conflict = '---\nname: test-skill\n---\nMy custom skill\n'
    await writeCopy(home.claude, conflict)
    await autoUpdateInstalledBundledSkills({
      ...serviceInput(home, { installedOnly: true }),
      sources: [SOURCE],
      names: [NAME]
    })
    expect(await read(home.claude)).toBe(conflict)
    expect(await read(former(home.claude))).toBe(FORMER_TEXT)
  })

  it.each([false, true])(
    'does not adopt a former shortcut to an unverified canonical target, missing: %s',
    async (missing) => {
      const home = await makeSkillHome()
      await mkdir(dirname(home.shared), { recursive: true })
      if (!missing) {
        await writeCopy(home.shared, '---\nname: test-skill\n---\nAnother tool\n')
      }
      await linkDirectory(home.shared, former(home.shared))
      await mkdir(dirname(home.claude), { recursive: true })
      await linkDirectory(former(home.shared), former(home.claude))
      const before = await snapshot(former(home.claude))
      await autoUpdateInstalledBundledSkills({
        ...serviceInput(home, { installedOnly: true }),
        sources: [SOURCE],
        names: [NAME]
      })
      expect(await snapshot(former(home.claude))).toBe(before)
      expect(await snapshot(home.claude)).toBe('missing')
      if (missing) {
        expect(await snapshot(home.shared)).toBe('missing')
      }
    }
  )

  it.each(['receipt', 'transaction', 'lock'] as const)(
    'respects the former path’s %s',
    async (state) => {
      const home = await makeSkillHome()
      const old = former(home.claude)
      await writeCopy(old, FORMER_TEXT)
      let release: (() => Promise<void>) | undefined
      if (state === 'lock') {
        release = await acquireSkillInstallLock({ path: skillInstallLockPath(home.state, old) })
      } else {
        const path =
          state === 'receipt'
            ? skillInstallReceiptPath(home.state, old)
            : skillInstallJournalPath(home.state, old)
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, '{}')
      }
      try {
        await autoUpdateInstalledBundledSkills({
          ...serviceInput(home, { installedOnly: true }),
          sources: [SOURCE],
          names: [NAME]
        })
        expect(await read(old)).toBe(FORMER_TEXT)
        expect(await snapshot(home.claude)).toBe('missing')
      } finally {
        await release?.()
      }
    }
  )

  it('preserves an edit racing retirement and finishes on a later run', async () => {
    const home = await makeSkillHome()
    const old = former(home.claude)
    await writeCopy(old, FORMER_TEXT)
    let raced = false
    const filesystem = {
      ...nativeBundledSkillFilesystem,
      rename: async (from: string, to: string) => {
        await nativeBundledSkillFilesystem.rename(from, to)
        if (from === old && !raced) {
          raced = true
          await writeFile(join(to, 'SKILL.md'), `${FORMER_TEXT}late edit`)
        }
      }
    }
    const input = { ...serviceInput(home, { installedOnly: true, filesystem }), sources: [SOURCE] }
    const plan = await previewBundledSkillInstall(input)
    const result = await installBundledSkills(input, plan.planDigest)
    expect(result.skills[0]?.ops[0]?.status).toBe('changed')
    expect(await read(old)).toBe(`${FORMER_TEXT}late edit`)
    expect(await read(home.claude)).toBe(NEW_TEXT)
  })

  it('recovers a former-name sibling left by an interrupted retirement', async () => {
    const home = await makeSkillHome()
    await writeCopy(join(dirname(home.claude), `.${FORMER_NAME}.orca-old-interrupted`), FORMER_TEXT)
    const input = { ...serviceInput(home, { installedOnly: true }), sources: [SOURCE] }
    await previewAndInstall(input)
    await previewAndInstall(input)
    expect(await read(home.claude)).toBe(NEW_TEXT)
    expect(await snapshot(former(home.claude))).toBe('missing')
  })

  it('leaves former-name recovery alone while a cloud transaction owns that path', async () => {
    const home = await makeSkillHome()
    const old = former(home.claude)
    const sibling = join(dirname(home.claude), `.${FORMER_NAME}.orca-old-interrupted`)
    await writeCopy(sibling, FORMER_TEXT)
    const journal = skillInstallJournalPath(home.state, old)
    await mkdir(dirname(journal), { recursive: true })
    await writeFile(journal, '{}')
    const input = { ...serviceInput(home, { installedOnly: true }), sources: [SOURCE] }
    const plan = await previewBundledSkillInstall(input)
    await installBundledSkills(input, plan.planDigest)
    expect(await read(sibling)).toBe(FORMER_TEXT)
    expect(await snapshot(old)).toBe('missing')
  })

  it('migrates links through a symlinked shared skills root', async () => {
    const home = await makeSkillHome()
    const outside = join(home.root, 'relocated-skills')
    await writeCopy(join(outside, FORMER_NAME), FORMER_TEXT)
    await mkdir(dirname(dirname(home.shared)), { recursive: true })
    await linkDirectory(outside, dirname(home.shared))
    await mkdir(dirname(home.claude), { recursive: true })
    await linkDirectory(former(home.shared), former(home.claude))
    await previewAndInstall({ ...serviceInput(home, { installedOnly: true }), sources: [SOURCE] })
    expect(await read(home.claude)).toBe(NEW_TEXT)
    expect(await snapshot(former(home.claude))).toBe('missing')
  })

  it('migrates a folder workspace without changing global installations', async () => {
    const home = await makeSkillHome()
    const project = join(home.root, 'plain-folder')
    const shared = join(project, '.agents', 'skills', NAME)
    const claude = join(project, '.claude', 'skills', NAME)
    await writeCopy(former(home.shared), FORMER_TEXT)
    await writeCopy(former(shared), FORMER_TEXT)
    await mkdir(dirname(claude), { recursive: true })
    await linkDirectory(former(shared), former(claude))
    await previewAndInstall({
      ...serviceInput(home, { workspaceDirectory: project, installedOnly: true }),
      sources: [SOURCE]
    })
    expect(await read(shared)).toBe(NEW_TEXT)
    expect(await read(claude)).toBe(NEW_TEXT)
    expect(await read(former(home.shared))).toBe(FORMER_TEXT)
    expect(await snapshot(home.shared)).toBe('missing')
  })
})
