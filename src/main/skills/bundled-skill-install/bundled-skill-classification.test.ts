import { chmod, mkdir, writeFile } from 'node:fs/promises'
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

async function writeSidecar(path: string, text: string): Promise<void> {
  await writeCopy(path, text)
  await mkdir(join(path, 'agents'))
  await writeFile(join(path, 'agents', 'openai.yaml'), 'display_name: test\n')
}

describe('classifyBundledSkillPath', () => {
  it('reads a current skill beside a Codex sidecar as current (#40181)', async () => {
    const { root } = await makeSkillHome()
    const path = join(root, NAME)
    await writeSidecar(path, NEW_TEXT)
    const classified = await classify(path)
    expect(classified.folderClass).toBe('current')
    expect(classified.observed).toMatchObject({ kind: 'folder', skillDigest: currentDigest })
  })

  it('reads an older released skill beside a Codex sidecar as released', async () => {
    const { root } = await makeSkillHome()
    const path = join(root, NAME)
    await writeSidecar(path, OLD_TEXT)
    expect((await classify(path)).folderClass).toBe('released')
  })

  it('still reads a drifted SKILL.md beside a sidecar as edited', async () => {
    const { root } = await makeSkillHome()
    const path = join(root, NAME)
    await writeSidecar(path, `${NEW_TEXT}\nlocal edit\n`)
    expect((await classify(path)).folderClass).toBe('edited')
  })

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
