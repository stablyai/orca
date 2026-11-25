import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { nativeBundledSkillFilesystem } from './bundled-skill-filesystem'
import { installBundledSkills, previewBundledSkillInstall } from './bundled-skill-installation'
import { filesystemErrorCode } from './bundled-skill-filesystem-error'
import {
  makeSkillHome,
  NAME,
  removeSkillHomes,
  serviceInput,
  writeCopy
} from './testing/bundled-skill-home'

const volume = process.env.ORCA_EXDEV_VOLUME

describe.skipIf(!volume)('cross-volume Replace (real second volume)', () => {
  afterEach(removeSkillHomes)

  it('leaves all bytes in place and does no backup work after the rejected rename', async () => {
    const home = await makeSkillHome()
    const project = await mkdtemp(join(volume!, 'orca-exdev-'))
    try {
      const skills = join(project, '.agents', 'skills')
      const skill = join(skills, NAME)
      const backups = join(home.home, '.agents', '.orca-skill-backups')
      const edited = `---\nname: ${NAME}\n---\nmine\n`
      await writeCopy(skill, edited)
      for (let index = 0; index < 400; index += 1) {
        await writeFile(join(skill, `f${index}.bin`), Buffer.alloc(16 * 1024, index))
      }
      expect((await stat(skill)).dev).not.toBe((await stat(home.home)).dev)
      const input = serviceInput(home, { agents: [], force: [skill], workspaceDirectory: project })
      const plan = await previewBundledSkillInstall(input)
      let refused = false
      let treeReadsAfterRefusal = 0
      const countRefusedTreeRead = (path: string) => {
        if (refused && path.startsWith(skill)) {
          treeReadsAfterRefusal += 1
        }
      }
      const result = await installBundledSkills(
        {
          ...input,
          filesystem: {
            ...nativeBundledSkillFilesystem,
            rename: async (source, target) => {
              try {
                await nativeBundledSkillFilesystem.rename(source, target)
              } catch (error) {
                if (filesystemErrorCode(error) === 'EXDEV') {
                  refused = true
                }
                throw error
              }
            },
            hashFile: async (path) => {
              countRefusedTreeRead(path)
              return nativeBundledSkillFilesystem.hashFile?.(path) ?? null
            },
            readFile: async (path, maxBytes) => {
              countRefusedTreeRead(path)
              return nativeBundledSkillFilesystem.readFile(path, maxBytes)
            },
            listEntries: async (directory) => {
              countRefusedTreeRead(directory)
              return nativeBundledSkillFilesystem.listEntries(directory)
            }
          }
        },
        plan.planDigest
      )
      expect(result.skills[0].ops[0]).toEqual({
        path: skill,
        kind: 'replace',
        status: 'failed',
        error: 'EXDEV',
        backupRefusal: { path: skill, source: 'in-place' }
      })
      expect(refused).toBe(true)
      expect(treeReadsAfterRefusal).toBe(0)
      expect(await readdir(backups)).toEqual([])
      expect(await readdir(skills)).toEqual([NAME])
      expect(await readdir(skill)).toHaveLength(401)
      expect(await readFile(join(skill, 'SKILL.md'), 'utf8')).toBe(edited)
      expect((await previewBundledSkillInstall(input)).planDigest).toBe(plan.planDigest)
    } finally {
      await rm(project, { recursive: true, force: true })
    }
  }, 120_000)
})
