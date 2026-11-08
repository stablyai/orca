import { mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { linkAntigravityUserSkills } from './antigravity-chat-user-skills'

let root: string
let chatHome: string
let userHome: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agy-user-skills-'))
  chatHome = join(root, 'antigravity-chat')
  userHome = join(root, 'home')
  await mkdir(join(userHome, '.gemini', 'config', 'skills', 'orca-cli'), { recursive: true })
  await writeFile(join(userHome, '.gemini', 'config', 'skills', 'orca-cli', 'SKILL.md'), 'skill')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

it('replaces the empty placeholder with a link to the user skills', async () => {
  await mkdir(join(chatHome, 'config', 'skills'), { recursive: true })

  await linkAntigravityUserSkills(chatHome, userHome)

  const linked = join(chatHome, 'config', 'skills', 'orca-cli', 'SKILL.md')
  expect(await readFile(linked, 'utf8')).toBe('skill')
  // No ~/.gemini/antigravity-cli/skills, so nothing is linked there.
  await expect(readlink(join(chatHome, 'antigravity-cli', 'skills'))).rejects.toThrow()
})

it('keeps a folder that already has content', async () => {
  const own = join(chatHome, 'config', 'skills', 'mine', 'SKILL.md')
  await mkdir(join(chatHome, 'config', 'skills', 'mine'), { recursive: true })
  await writeFile(own, 'mine')

  await linkAntigravityUserSkills(chatHome, userHome)

  expect(await readFile(own, 'utf8')).toBe('mine')
})

it('removes a link whose target is gone', async () => {
  const link = join(chatHome, 'antigravity-cli', 'skills')
  await mkdir(join(chatHome, 'antigravity-cli'), { recursive: true })
  await symlink(join(userHome, '.gemini', 'antigravity-cli', 'skills'), link, 'dir')

  await linkAntigravityUserSkills(chatHome, userHome)

  await expect(readlink(link)).rejects.toThrow()
})
