import type * as FsPromises from 'node:fs/promises'
import { mkdir, mkdtemp, readFile, readlink, rm, rmdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { linkAntigravityUserSkills } from './antigravity-chat-user-skills'

const fsCalls = vi.hoisted(() => ({ count: 0 }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof FsPromises>()
  const counted =
    <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
    (...args: A) => {
      fsCalls.count++
      return fn(...args)
    }
  return { ...real, lstat: counted(real.lstat), rmdir: vi.fn(real.rmdir) }
})

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
  vi.mocked(rmdir).mockRestore()
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

it('removes a link whose target is gone', async () => {
  const link = join(chatHome, 'antigravity-cli', 'skills')
  const target = join(userHome, '.gemini', 'antigravity-cli', 'skills')
  await mkdir(join(chatHome, 'antigravity-cli'), { recursive: true })
  await mkdir(target, { recursive: true })
  // Windows creates directory links without extra rights only as junctions, to a target that exists.
  await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  await rm(target, { recursive: true })

  await linkAntigravityUserSkills(chatHome, userHome)

  await expect(readlink(link)).rejects.toThrow()
})

it('lets one launch finish linking before another starts on the same chat home', async () => {
  const realRmdir = vi.mocked(rmdir).getMockImplementation()!
  await mkdir(join(chatHome, 'config', 'skills'), { recursive: true })
  let release!: () => void
  const held = new Promise<void>((resolve) => (release = resolve))
  let first!: () => void
  const firstRemoving = new Promise<void>((resolve) => (first = resolve))
  vi.mocked(rmdir).mockImplementationOnce(async (path) => {
    first()
    await held
    return realRmdir(path)
  })
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

  const one = linkAntigravityUserSkills(chatHome, userHome)
  await firstRemoving
  const before = fsCalls.count
  const two = linkAntigravityUserSkills(chatHome, userHome)
  // A second launch that started at once would already have looked at the folder.
  expect(fsCalls.count).toBe(before)
  release()
  await Promise.all([one, two])

  expect(warn).not.toHaveBeenCalled()
  const linked = join(chatHome, 'config', 'skills', 'orca-cli', 'SKILL.md')
  expect(await readFile(linked, 'utf8')).toBe('skill')
  warn.mockRestore()
})
