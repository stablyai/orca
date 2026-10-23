import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { nativeBundledSkillFilesystem, type BundledSkillFilesystem } from './filesystem'
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

function unreadableFile(path: string, throws = false): BundledSkillFilesystem {
  const unavailable = () => {
    if (throws) {
      throw Object.assign(new Error('unreadable'), { code: 'EACCES' })
    }
    return null
  }
  return {
    ...nativeBundledSkillFilesystem,
    readFile: async (file) =>
      file === path ? unavailable() : nativeBundledSkillFilesystem.readFile(file),
    hashFile: async (file) =>
      file === path ? unavailable() : (nativeBundledSkillFilesystem.hashFile?.(file) ?? null)
  }
}

describe('unreadable bundled skill content', () => {
  it.each([`---\nname: ${NAME}\n---\nmine\n`, 'another skill\n'])(
    'leaves an ordinary copy alone while updating another target: %s',
    async (text) => {
      const home = await makeSkillHome()
      await writeCopy(home.shared, text)
      const auxiliary = join(home.shared, 'scripts', 'run.sh')
      await mkdir(dirname(auxiliary))
      await writeFile(auxiliary, 'mine')
      await writeCopy(home.claude, OLD_TEXT)
      const { plan } = await previewAndInstall(
        serviceInput(home, { filesystem: unreadableFile(auxiliary) })
      )
      expect(plan.skills[0].ops.map((op) => op.kind)).toEqual(['leave', 'update'])
      expect(await readFile(join(home.shared, 'SKILL.md'), 'utf8')).toBe(text)
      expect(await readFile(join(home.claude, 'SKILL.md'), 'utf8')).toBe(NEW_TEXT)
    }
  )

  it.each([false, true])(
    'blocks only the forced target whose identity fails (throws: %s)',
    async (throws) => {
      const home = await makeSkillHome()
      await writeCopy(home.shared, `---\nname: ${NAME}\n---\nmine\n`, { 'notes.md': 'mine' })
      await writeCopy(home.claude, 'another skill\n', { 'notes.md': 'theirs' })
      await writeCopy(home.cursor, OLD_TEXT)
      const { plan } = await previewAndInstall(
        serviceInput(home, {
          agents: ['claude', 'cursor'],
          force: [home.shared, home.claude],
          filesystem: unreadableFile(join(home.shared, 'notes.md'), throws)
        })
      )
      expect(plan.skills[0].ops[0]).toMatchObject({
        kind: 'leave',
        reason: 'unreadable',
        replaceable: false
      })
      expect(plan.skills[0].ops.map((op) => op.kind)).toEqual(['leave', 'replace', 'update'])
      expect(await readFile(join(home.shared, 'notes.md'), 'utf8')).toBe('mine')
      expect(await readFile(join(home.claude, 'SKILL.md'), 'utf8')).toBe(NEW_TEXT)
      expect(await readFile(join(home.cursor, 'SKILL.md'), 'utf8')).toBe(NEW_TEXT)
    }
  )

  it('preserves a copy with an unreadable SKILL.md during ordinary planning', async () => {
    const home = await makeSkillHome()
    await writeCopy(home.shared, OLD_TEXT)
    await writeCopy(home.claude, OLD_TEXT)
    const { plan } = await previewAndInstall(
      serviceInput(home, {
        filesystem: unreadableFile(join(home.claude, 'SKILL.md'))
      })
    )
    expect(plan.skills[0].ops.map((op) => op.kind)).toEqual(['update', 'leave'])
    expect(await readFile(join(home.claude, 'SKILL.md'), 'utf8')).toBe(OLD_TEXT)
  })

  it('does not replace an unreadable plain file', async () => {
    const home = await makeSkillHome()
    await mkdir(dirname(home.shared), { recursive: true })
    await writeFile(home.shared, 'mine')
    const plan = await previewBundledSkillInstall(
      serviceInput(home, {
        force: [home.shared],
        filesystem: unreadableFile(home.shared)
      })
    )
    expect(plan.skills[0].ops[0]).toMatchObject({
      kind: 'leave',
      reason: 'unreadable',
      replaceable: false
    })
    expect(await readFile(home.shared, 'utf8')).toBe('mine')
  })

  it('retains an unreadable recovery sibling while updating a readable target', async () => {
    const home = await makeSkillHome()
    await writeCopy(home.shared, OLD_TEXT)
    const old = join(dirname(home.shared), `.${NAME}.orca-old-1`)
    await writeCopy(old, 'mine', { 'notes.md': 'mine' })
    const { plan } = await previewAndInstall(
      serviceInput(home, {
        filesystem: unreadableFile(join(old, 'notes.md'))
      })
    )
    expect(plan.skills[0].ops[0]).toMatchObject({ kind: 'update', cleanup: [] })
    expect(await readFile(join(old, 'notes.md'), 'utf8')).toBe('mine')
  })
})
