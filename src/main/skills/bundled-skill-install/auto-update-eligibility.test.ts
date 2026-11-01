import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bundledSkillNudgeEntries } from '../../../shared/bundled-skill-summary'
import type { BundledSkillSource } from './bundled-skill-sources'
import { nativeBundledSkillFilesystem, type BundledSkillFilesystem } from './filesystem'
import {
  autoUpdateInstalledBundledSkills,
  installBundledSkills,
  previewBundledSkillInstall
} from './service'
import {
  makeSkillHome,
  removeSkillHomes,
  serviceInput,
  writeCopy,
  type SkillHome
} from './skill-home.test-support'

afterEach(removeSkillHomes)

const text = (name: string, body: string) => `---\nname: ${name}\ndescription: d\n---\n\n${body}\n`
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const NAMES = ['alpha', 'bravo', 'charlie']
const SOURCES: BundledSkillSource[] = NAMES.map((name) => ({
  name,
  text: text(name, 'new'),
  releasedDigests: [digest(text(name, 'old')), digest(text(name, 'new'))]
}))

const skillPath = (home: SkillHome, root: 'shared' | 'claude', name: string) =>
  join(dirname(home[root]), name)

function input(home: SkillHome, filesystem: BundledSkillFilesystem = nativeBundledSkillFilesystem) {
  return { ...serviceInput(home, { installedOnly: true, filesystem }), sources: SOURCES }
}

async function readSkill(home: SkillHome, root: 'shared' | 'claude', name: string) {
  return readFile(join(skillPath(home, root, name), 'SKILL.md'), 'utf8').catch(() => 'missing')
}

/** An editor holding SKILL.md open saves into the folder the swap just moved aside. */
function lateWriterFilesystem(home: SkillHome): BundledSkillFilesystem {
  const target = skillPath(home, 'shared', 'alpha')
  return {
    ...nativeBundledSkillFilesystem,
    rename: async (source, destination) => {
      await nativeBundledSkillFilesystem.rename(source, destination)
      if (source === target && basename(destination).startsWith('.alpha.orca-old')) {
        await writeFile(join(destination, 'SKILL.md'), text('alpha', 'late edit'))
      }
    }
  }
}

describe('per-skill silent update of unedited Orca copies', () => {
  it('updates every unedited skill, including CRLF legacy copies, and leaves nothing to ask', async () => {
    const home = await makeSkillHome()
    for (const name of NAMES) {
      await writeCopy(skillPath(home, 'shared', name), text(name, 'old'))
      await writeCopy(skillPath(home, 'claude', name), text(name, 'old').replace(/\n/gu, '\r\n'))
    }

    const result = await autoUpdateInstalledBundledSkills({ ...input(home), names: NAMES })

    expect(result.skills.flatMap((skill) => skill.ops.map((op) => op.status))).toEqual(
      Array(6).fill('done')
    )
    for (const name of NAMES) {
      expect(await readSkill(home, 'shared', name)).toBe(text(name, 'new'))
      expect(await readSkill(home, 'claude', name)).toBe(text(name, 'new'))
    }
    expect(bundledSkillNudgeEntries(await previewBundledSkillInstall(input(home)))).toEqual([])
  })

  it('updates only the unedited skill and leaves a repair and an edited copy to ask about', async () => {
    const home = await makeSkillHome()
    await writeCopy(skillPath(home, 'shared', 'alpha'), text('alpha', 'old'))
    // An interrupted swap: the target is gone and Orca's old copy waits to be restored.
    await writeCopy(join(dirname(home.shared), '.bravo.orca-old-1'), text('bravo', 'old'))
    await writeCopy(skillPath(home, 'shared', 'charlie'), text('charlie', 'my own notes'))

    const result = await autoUpdateInstalledBundledSkills({ ...input(home), names: NAMES })

    expect(result.skills.map((skill) => skill.name)).toEqual(['alpha'])
    expect(await readSkill(home, 'shared', 'alpha')).toBe(text('alpha', 'new'))
    expect(await readSkill(home, 'shared', 'bravo')).toBe('missing')
    expect(await readSkill(home, 'shared', 'charlie')).toBe(text('charlie', 'my own notes'))
    const remaining = bundledSkillNudgeEntries(await previewBundledSkillInstall(input(home)))
    expect(remaining.map((entry) => entry.name)).toEqual(['bravo', 'charlie'])
  })

  it('keeps the edited location of a skill while updating its unedited one', async () => {
    const home = await makeSkillHome()
    await writeCopy(skillPath(home, 'shared', 'alpha'), text('alpha', 'old'))
    await writeCopy(skillPath(home, 'claude', 'alpha'), text('alpha', 'old'), { 'notes.md': 'x' })

    await autoUpdateInstalledBundledSkills({ ...input(home), names: ['alpha'] })

    expect(await readSkill(home, 'shared', 'alpha')).toBe(text('alpha', 'new'))
    expect(await readSkill(home, 'claude', 'alpha')).toBe(text('alpha', 'old'))
  })

  it('leaves only the skill whose silent update failed for the prompt', async () => {
    const home = await makeSkillHome()
    for (const name of NAMES) {
      await writeCopy(skillPath(home, 'shared', name), text(name, 'old'))
    }
    const failBravo: BundledSkillFilesystem = {
      ...nativeBundledSkillFilesystem,
      rename: async (source, target) => {
        if ([source, target].some((path) => basename(path) === 'bravo')) {
          throw Object.assign(new Error('denied'), { code: 'EPERM' })
        }
        return nativeBundledSkillFilesystem.rename(source, target)
      }
    }

    const result = await autoUpdateInstalledBundledSkills({
      ...input(home, failBravo),
      names: NAMES
    })

    expect(result.skills.map((skill) => [skill.name, skill.ops[0]?.status])).toEqual([
      ['alpha', 'done'],
      ['bravo', 'failed'],
      ['charlie', 'done']
    ])
    expect(await readSkill(home, 'shared', 'bravo')).toBe(text('bravo', 'old'))
    const remaining = bundledSkillNudgeEntries(await previewBundledSkillInstall(input(home)))
    expect(remaining.map((entry) => entry.name)).toEqual(['bravo'])
  })

  it('reports a backup when a writer saves SKILL.md after the final verification', async () => {
    const home = await makeSkillHome()
    await writeCopy(skillPath(home, 'shared', 'alpha'), text('alpha', 'old'))
    const lateWriter = lateWriterFilesystem(home)

    const result = await autoUpdateInstalledBundledSkills({
      ...input(home, lateWriter),
      names: ['alpha']
    })

    const backupPath = result.skills[0]?.ops[0]?.backupPath
    expect(backupPath).toBeTruthy()
    expect(await readFile(join(backupPath ?? '', 'SKILL.md'), 'utf8')).toBe(
      text('alpha', 'late edit')
    )
    expect(await readSkill(home, 'shared', 'alpha')).toBe(text('alpha', 'new'))
  })

  it('reports where unpreservable edits remain and never deletes them', async () => {
    const home = await makeSkillHome()
    await writeCopy(skillPath(home, 'shared', 'alpha'), text('alpha', 'old'))
    // The shared backup directory refuses writes, as when it is not writable by this user.
    const unwritableBackups = (filesystem: BundledSkillFilesystem): BundledSkillFilesystem => ({
      ...filesystem,
      moveToBackup: async () => {
        throw Object.assign(new Error('denied'), { code: 'EACCES' })
      }
    })

    const result = await autoUpdateInstalledBundledSkills({
      ...input(home, unwritableBackups(lateWriterFilesystem(home))),
      names: ['alpha']
    })

    const outcome = result.skills[0]?.ops[0]
    expect(outcome).toMatchObject({ status: 'failed', error: 'EACCES' })
    const stranded = outcome?.strandedPath ?? ''
    expect(basename(stranded)).toMatch(/^\.alpha\.orca-old/u)
    expect(await readFile(join(stranded, 'SKILL.md'), 'utf8')).toBe(text('alpha', 'late edit'))
    expect(await readSkill(home, 'shared', 'alpha')).toBe(text('alpha', 'new'))

    const plan = await previewBundledSkillInstall(input(home))
    expect(plan.skills[0]?.ops[0]?.cleanup).toEqual([
      expect.objectContaining({ path: stranded, action: 'backup' })
    ])
    expect(bundledSkillNudgeEntries(plan).map((entry) => entry.name)).toEqual(['alpha'])

    // Settling that cleanup while backups stay unwritable must leave the edit in place.
    await installBundledSkills(
      input(home, unwritableBackups(nativeBundledSkillFilesystem)),
      plan.planDigest
    )
    expect(await readFile(join(stranded, 'SKILL.md'), 'utf8')).toBe(text('alpha', 'late edit'))
  })
})
