import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  nativeBundledSkillFilesystem,
  type BundledSkillFilesystem
} from '../bundled-skill-filesystem'
import { OLD_TEXT } from './bundled-skill-home'

/** Refuses backups as cross-drive, edits the retiring copy after its move aside, and counts later reads. */
export function lateEditingFilesystem(
  backups: string,
  retiring: string,
  beforeRefusal: () => Promise<void> = async () => undefined
) {
  let oldPath = ''
  let oldReads = 0
  let refused = false
  let readsAfterRefusal = 0
  const count = (path: string) => {
    if (refused && oldPath && (path.startsWith(oldPath) || path.startsWith(retiring))) {
      readsAfterRefusal += 1
    }
  }
  const filesystem: BundledSkillFilesystem = {
    ...nativeBundledSkillFilesystem,
    rename: async (source, target) => {
      if (dirname(target) === backups) {
        refused = true
        await beforeRefusal()
        throw Object.assign(new Error('cross-device rename'), { code: 'EXDEV' })
      }
      if (source === retiring) {
        oldPath = target
      }
      return nativeBundledSkillFilesystem.rename(source, target)
    },
    readFile: async (path, maxBytes) => {
      count(path)
      if (oldPath && path === join(oldPath, 'SKILL.md') && ++oldReads === 2) {
        await writeFile(path, `${OLD_TEXT}Late edit\n`)
      }
      return nativeBundledSkillFilesystem.readFile(path, maxBytes)
    },
    hashFile: async (path) => {
      count(path)
      return nativeBundledSkillFilesystem.hashFile!(path)
    },
    listEntries: async (directory) => {
      count(directory)
      return nativeBundledSkillFilesystem.listEntries(directory)
    }
  }
  return {
    filesystem,
    oldPath: () => oldPath,
    readsAfterRefusal: () => readsAfterRefusal
  }
}
