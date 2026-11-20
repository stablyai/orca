import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bundledSkillNudgeEntries } from '../../../shared/skills/bundled/bundled-skill-summary'
import type { BundledSkillSource } from './bundled-skill-sources'
import {
  nativeBundledSkillFilesystem,
  type BundledSkillFilesystem
} from './bundled-skill-filesystem'
import {
  autoUpdateInstalledBundledSkills,
  previewBundledSkillInstall
} from './bundled-skill-installation'
import {
  makeSkillHome,
  removeSkillHomes,
  serviceInput,
  writeCopy,
  type SkillHome
} from './testing/bundled-skill-home'

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

  it('updates SKILL.md beside files the user added and keeps an edited SKILL.md', async () => {
    const home = await makeSkillHome()
    const sidecar = join(skillPath(home, 'shared', 'alpha'), 'agents', 'openai.yaml')
    await writeCopy(skillPath(home, 'shared', 'alpha'), text('alpha', 'old'))
    await mkdir(dirname(sidecar))
    await writeFile(sidecar, 'interface:\n  display_name: Alpha\n')
    await writeCopy(skillPath(home, 'claude', 'alpha'), text('alpha', 'mine'), { 'notes.md': 'x' })

    await autoUpdateInstalledBundledSkills({ ...input(home), names: ['alpha'] })

    expect(await readSkill(home, 'shared', 'alpha')).toBe(text('alpha', 'new'))
    expect(await readFile(sidecar, 'utf8')).toBe('interface:\n  display_name: Alpha\n')
    expect((await readdir(skillPath(home, 'shared', 'alpha'))).sort()).toEqual([
      'SKILL.md',
      'agents'
    ])
    expect(await readSkill(home, 'claude', 'alpha')).toBe(text('alpha', 'mine'))
    const remaining = bundledSkillNudgeEntries(await previewBundledSkillInstall(input(home)))
    expect(remaining.flatMap((entry) => entry.ops.map((op) => [op.kind, op.reason]))).toEqual([
      ['keep', undefined],
      ['leave', 'edited']
    ])
  })

  // Windows refuses to rename over a SKILL.md an editor holds open.
  it('leaves only the skill whose silent update failed for the prompt', async () => {
    const home = await makeSkillHome()
    for (const name of NAMES) {
      await writeCopy(skillPath(home, 'shared', name), text(name, 'old'))
    }
    const failBravo: BundledSkillFilesystem = {
      ...nativeBundledSkillFilesystem,
      rename: async (source, target) => {
        if (basename(dirname(target)) === 'bravo') {
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
    expect(await readdir(skillPath(home, 'shared', 'bravo'))).toEqual(['SKILL.md'])
    const remaining = bundledSkillNudgeEntries(await previewBundledSkillInstall(input(home)))
    expect(remaining.map((entry) => entry.name)).toEqual(['bravo'])
  })
})
