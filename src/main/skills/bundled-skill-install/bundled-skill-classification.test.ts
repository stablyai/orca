import { chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bundledSkillTextDigest, classifyBundledSkillPath } from './bundled-skill-classification'
import { nativeBundledSkillFilesystem } from './bundled-skill-filesystem'
import {
  makeSkillHome,
  NAME,
  NEW_SOURCE,
  NEW_TEXT,
  OLD_TEXT,
  removeSkillHomes,
  writeCopy
} from './testing/bundled-skill-home'

afterEach(async () => {
  await removeSkillHomes()
})

const currentDigest = bundledSkillTextDigest(Buffer.from(NEW_TEXT))
const classify = (path: string) =>
  classifyBundledSkillPath(nativeBundledSkillFilesystem, path, NEW_SOURCE, currentDigest)

describe('classifyBundledSkillPath', () => {
  it.runIf(process.platform !== 'win32' && process.getuid?.() !== 0)(
    'reads an unlistable folder as another skill',
    async () => {
      const { root } = await makeSkillHome()
      await writeCopy(join(root, NAME), OLD_TEXT)
      await chmod(join(root, NAME), 0o000)
      try {
        expect(await classify(join(root, NAME))).toEqual({
          folderClass: 'other',
          observed: { kind: 'unreadable' }
        })
      } finally {
        await chmod(join(root, NAME), 0o755)
      }
    }
  )
})
