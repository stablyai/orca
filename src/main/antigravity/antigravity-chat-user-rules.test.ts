import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { copyAntigravityUserRules } from './antigravity-chat-user-skills'

let root = ''
afterEach(() => {
  chmodSync(join(root, 'user', '.gemini'), 0o700)
  rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function homes() {
  root = mkdtempSync(join(tmpdir(), 'agy-rules-'))
  const user = join(root, 'user')
  const chat = join(root, 'chat')
  mkdirSync(join(user, '.gemini'), { recursive: true })
  mkdirSync(chat)
  return { user, chat, rules: join(user, '.gemini', 'GEMINI.md') }
}

it("copies ~/.gemini/GEMINI.md into the chat home, and drops the copy once it's gone", async () => {
  const { user, chat, rules } = homes()
  writeFileSync(rules, 'be brief')
  await copyAntigravityUserRules(chat, user)
  expect(readFileSync(join(chat, 'GEMINI.md'), 'utf8')).toBe('be brief')
  rmSync(rules)
  await copyAntigravityUserRules(chat, user)
  expect(existsSync(join(chat, 'GEMINI.md'))).toBe(false)
  expect(readdirSync(chat)).toEqual([])
})

it('replaces a link planted at the copy instead of writing through it', async () => {
  const { user, chat, rules } = homes()
  writeFileSync(rules, 'be brief')
  const elsewhere = join(root, 'elsewhere.md')
  writeFileSync(elsewhere, 'untouched')
  symlinkSync(elsewhere, join(chat, 'GEMINI.md'))
  await copyAntigravityUserRules(chat, user)
  expect(lstatSync(join(chat, 'GEMINI.md')).isSymbolicLink()).toBe(false)
  expect(readFileSync(join(chat, 'GEMINI.md'), 'utf8')).toBe('be brief')
  expect(readFileSync(elsewhere, 'utf8')).toBe('untouched')
})

it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
  "keeps the home's copy when the user's rules exist but can't be read",
  async () => {
    const { user, chat, rules } = homes()
    writeFileSync(rules, 'be brief')
    await copyAntigravityUserRules(chat, user)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    chmodSync(rules, 0o000)
    await copyAntigravityUserRules(chat, user)
    chmodSync(rules, 0o600)
    expect(readFileSync(join(chat, 'GEMINI.md'), 'utf8')).toBe('be brief')
    expect(readdirSync(chat)).toEqual(['GEMINI.md'])
  }
)
