import { mkdir, readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { BundledSkillFilesystem } from './bundled-skill-filesystem'
import { installBundledSkills, previewBundledSkillInstall } from './bundled-skill-installation'
import {
  leftoverSiblings,
  makeSkillHome,
  NAME,
  NEW_SOURCE,
  NEW_TEXT,
  OLD_TEXT,
  removeSkillHomes,
  serviceInput,
  snapshot,
  writeCopy
} from './testing/bundled-skill-home'
import { lateEditingFilesystem } from './testing/late-editing-filesystem'

afterEach(async () => {
  await removeSkillHomes()
})

// A refused retirement with no forwarding link puts the edited copy back where the user left it.
describe('cross-drive refusal put-back', () => {
  it.each(['former root', 'former name in an agent folder'] as const)(
    'puts a refused %s copy back where the user left it',
    async (placement) => {
      const home = await makeSkillHome()
      const alias = 'former-skill'
      const former =
        placement === 'former root'
          ? join(home.home, '.gemini', 'skills', NAME)
          : join(dirname(home.claude), alias)
      await writeCopy(home.shared, OLD_TEXT)
      await writeCopy(former, OLD_TEXT)
      const backups = join(home.home, '.agents', '.orca-skill-backups')
      const late = lateEditingFilesystem(backups, former)
      const input = {
        ...serviceInput(home, { agents: ['claude'] }),
        sources: [{ ...NEW_SOURCE, aliases: [alias] }]
      }
      const plan = await previewBundledSkillInstall(input)
      const result = await installBundledSkills(
        { ...input, filesystem: late.filesystem },
        plan.planDigest
      )
      const retiring = result.skills[0].ops.find((op) => op.backupRefusal)
      expect(retiring).toMatchObject({
        status: 'failed',
        error: 'EXDEV',
        contentApplied: true,
        // A retired place may never be planned again, so this result is its only notice.
        backupRefusal: { path: former, source: 'in-place', onlyNotice: true }
      })
      expect(late.readsAfterRefusal()).toBe(0)
      const edited = `dir[SKILL.md]:${OLD_TEXT}Late edit\n`
      expect(await snapshot(former)).toBe(edited)
      expect(await leftoverSiblings(former)).toEqual([])
      expect(await readdir(backups)).toEqual([])
      expect(await readFile(join(home.shared, 'SKILL.md'), 'utf8')).toBe(NEW_TEXT)

      // Later plans, fresh and installed-only, leave the edited copy where it is.
      for (const later of [input, { ...input, installedOnly: true }]) {
        const next = await previewBundledSkillInstall(later)
        expect(next.skills[0].ops.some((op) => op.kind === 'restore')).toBe(false)
        // No later plan lists the put-back copy, so "Orca won't remind you" stays true.
        expect(JSON.stringify(next.skills[0])).not.toContain(former)
        await installBundledSkills(later, next.planDigest)
        expect(await snapshot(former)).toBe(edited)
        expect(await leftoverSiblings(former)).toEqual([])
      }
      expect(await readdir(backups)).toEqual([])
    }
  )

  it('reports the moved-aside path once when the put-back finds the place taken', async () => {
    const home = await makeSkillHome()
    const former = join(home.home, '.gemini', 'skills', NAME)
    await writeCopy(home.shared, OLD_TEXT)
    await writeCopy(former, OLD_TEXT)
    const backups = join(home.home, '.agents', '.orca-skill-backups')
    const late = lateEditingFilesystem(backups, former, () => writeCopy(former, 'someone else\n'))
    const input = serviceInput(home, { agents: ['claude'] })
    const plan = await previewBundledSkillInstall(input)
    const result = await installBundledSkills(
      { ...input, filesystem: late.filesystem },
      plan.planDigest
    )
    const oldPath = late.oldPath()
    expect(result.skills[0].ops[0].backupRefusal).toEqual({
      path: oldPath,
      source: 'moved-aside',
      onlyNotice: true
    })
    expect(await readFile(join(oldPath, 'SKILL.md'), 'utf8')).toBe(`${OLD_TEXT}Late edit\n`)
    expect(await readFile(join(former, 'SKILL.md'), 'utf8')).toBe('someone else\n')
  })

  // The check and the rename are separate steps, so a folder created between them is not covered.
  it('does not rename onto an empty folder that took the place before the put-back check', async () => {
    const home = await makeSkillHome()
    const former = join(home.home, '.gemini', 'skills', NAME)
    await writeCopy(home.shared, OLD_TEXT)
    await writeCopy(former, OLD_TEXT)
    const backups = join(home.home, '.agents', '.orca-skill-backups')
    // An empty directory is one a native rename could silently replace.
    const late = lateEditingFilesystem(backups, former, () => mkdir(former))
    let renamesOntoFormer = 0
    const filesystem: BundledSkillFilesystem = {
      ...late.filesystem,
      rename: async (source, target) => {
        if (target === former) {
          renamesOntoFormer += 1
        }
        return late.filesystem.rename(source, target)
      }
    }
    const input = serviceInput(home, { agents: ['claude'] })
    const plan = await previewBundledSkillInstall(input)
    const result = await installBundledSkills({ ...input, filesystem }, plan.planDigest)
    const oldPath = late.oldPath()
    expect(renamesOntoFormer).toBe(0)
    expect(result.skills[0].ops[0].backupRefusal).toEqual({
      path: oldPath,
      source: 'moved-aside',
      onlyNotice: true
    })
    expect(await readdir(former)).toEqual([])
    expect(await readFile(join(oldPath, 'SKILL.md'), 'utf8')).toBe(`${OLD_TEXT}Late edit\n`)
  })

  it('reports the moved-aside path when the put-back rename itself fails', async () => {
    const home = await makeSkillHome()
    const alias = 'former-skill'
    const former = join(dirname(home.claude), alias)
    await writeCopy(home.shared, OLD_TEXT)
    await writeCopy(former, OLD_TEXT)
    const backups = join(home.home, '.agents', '.orca-skill-backups')
    const late = lateEditingFilesystem(backups, former)
    let putBackAttempts = 0
    const filesystem: BundledSkillFilesystem = {
      ...late.filesystem,
      rename: async (source, target) => {
        if (target === former && source === late.oldPath()) {
          putBackAttempts += 1
          throw Object.assign(new Error('denied'), { code: 'EACCES' })
        }
        return late.filesystem.rename(source, target)
      }
    }
    const input = {
      ...serviceInput(home, { agents: ['claude'] }),
      sources: [{ ...NEW_SOURCE, aliases: [alias] }]
    }
    const plan = await previewBundledSkillInstall(input)
    const result = await installBundledSkills({ ...input, filesystem }, plan.planDigest)
    const oldPath = late.oldPath()
    expect(putBackAttempts).toBe(1)
    expect(result.skills[0].ops.find((op) => op.backupRefusal)?.backupRefusal).toEqual({
      path: oldPath,
      source: 'moved-aside'
    })
    expect(await snapshot(former)).toBe('missing')
    expect(await readFile(join(oldPath, 'SKILL.md'), 'utf8')).toBe(`${OLD_TEXT}Late edit\n`)
  })
})
