import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  openCodeSourceConfigDirectory,
  openCodeTakesConfigDirInstructions,
  writeOpenCodeInstructionsConfigDir
} from './opencode-instructions-config-dir'

let root = ''
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'opencode-instructions-config-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('OpenCode 2.x instructions config folder', () => {
  it('takes them in its config folder from 2.0 on only', () => {
    expect(openCodeTakesConfigDirInstructions('1.18.35')).toBe(false)
    expect(openCodeTakesConfigDirInstructions(null)).toBe(false)
    expect(openCodeTakesConfigDirInstructions('2.0.14')).toBe(true)
    expect(openCodeTakesConfigDirInstructions('2.1.0')).toBe(true)
  })

  it("starts from the child's own config folder, else the XDG one", () => {
    expect(openCodeSourceConfigDirectory({ OPENCODE_CONFIG_DIR: '/mine' })).toBe('/mine')
    expect(openCodeSourceConfigDirectory({ XDG_CONFIG_HOME: '/xdg', HOME: '/home/u' })).toBe(
      join('/xdg', 'opencode')
    )
  })

  it('writes only the instructions when the user has no config folder', async () => {
    const folder = join(root, 'chat')
    await mkdir(folder)
    await writeOpenCodeInstructionsConfigDir(folder, join(root, 'missing'), 'You are Zorblax.')
    expect(await readdir(folder)).toEqual(['AGENTS.md'])
    expect(await readFile(join(folder, 'AGENTS.md'), 'utf8')).toBe('You are Zorblax.\n')
  })

  it("links every other entry of the user's folder, folders included", async () => {
    const source = join(root, 'source')
    await mkdir(join(source, 'agents'), { recursive: true })
    await writeFile(join(source, 'agents', 'mine.md'), 'agent')
    await writeFile(join(source, 'opencode.jsonc'), '{}')
    const folder = join(root, 'chat')
    await mkdir(folder)
    await writeOpenCodeInstructionsConfigDir(folder, source, 'You are Zorblax.')
    expect((await readdir(folder)).toSorted()).toEqual(['AGENTS.md', 'agents', 'opencode.jsonc'])
    expect(await readFile(join(folder, 'agents', 'mine.md'), 'utf8')).toBe('agent')
  })

  it.skipIf(process.platform === 'win32')(
    'reads a config folder that is itself a link',
    async () => {
      const real = join(root, 'dotfiles-opencode')
      await mkdir(real)
      await writeFile(join(real, 'opencode.json'), '{}')
      await writeFile(join(real, 'AGENTS.md'), 'Mine.')
      await symlink(real, join(root, 'linked'), 'dir')
      const folder = join(root, 'chat')
      await mkdir(folder)
      await writeOpenCodeInstructionsConfigDir(folder, join(root, 'linked'), 'You are Zorblax.')
      expect((await readdir(folder)).toSorted()).toEqual(['AGENTS.md', 'opencode.json'])
      expect(await readFile(join(folder, 'AGENTS.md'), 'utf8')).toBe('Mine.\n\nYou are Zorblax.\n')
    }
  )
})
