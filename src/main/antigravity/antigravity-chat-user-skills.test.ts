import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
  existsSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { copyAntigravityUserRules, linkAntigravityUserSkills } from './antigravity-chat-user-skills'

let root = ''
afterEach(() => rmSync(root, { recursive: true, force: true }))

it("links agy's own skill folders into the app data folder agy reads on Orca's chat home", async () => {
  root = mkdtempSync(join(tmpdir(), 'agy-skills-'))
  const user = join(root, 'user')
  mkdirSync(join(user, '.gemini', 'antigravity-cli', 'skills'), { recursive: true })
  mkdirSync(join(user, '.gemini', 'config', 'skills'), { recursive: true })
  const chat = join(root, 'chat')
  await linkAntigravityUserSkills(chat, user, 'linux')
  expect(readlinkSync(join(chat, 'antigravity-acp', 'skills'))).toBe(
    join(user, '.gemini', 'antigravity-cli', 'skills')
  )
  expect(readlinkSync(join(chat, 'config', 'skills'))).toBe(
    join(user, '.gemini', 'config', 'skills')
  )
})

it("copies ~/.gemini/GEMINI.md into the chat home, and drops the copy once it's gone", async () => {
  root = mkdtempSync(join(tmpdir(), 'agy-rules-'))
  const user = join(root, 'user')
  const chat = join(root, 'chat')
  mkdirSync(join(user, '.gemini'), { recursive: true })
  mkdirSync(chat)
  writeFileSync(join(user, '.gemini', 'GEMINI.md'), 'be brief')
  await copyAntigravityUserRules(chat, user)
  expect(readFileSync(join(chat, 'GEMINI.md'), 'utf8')).toBe('be brief')
  rmSync(join(user, '.gemini', 'GEMINI.md'))
  await copyAntigravityUserRules(chat, user)
  expect(existsSync(join(chat, 'GEMINI.md'))).toBe(false)
})
