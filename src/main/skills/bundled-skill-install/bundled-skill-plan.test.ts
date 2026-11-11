import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  nativeBundledSkillFilesystem,
  type BundledSkillFilesystem
} from './bundled-skill-filesystem'
import { previewBundledSkillInstall } from './bundled-skill-installation'
import {
  makeSkillHome,
  NAME,
  OLD_TEXT,
  previewAndInstall,
  removeSkillHomes,
  serviceInput,
  writeCopy
} from './testing/bundled-skill-home'

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
