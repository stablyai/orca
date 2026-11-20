import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { copyAgyLoginIntoChatHome } from './antigravity-chat-agy-login-copy'

let root = ''
afterEach(() => rmSync(root, { recursive: true, force: true }))

function homes(signedIn = true) {
  root = mkdtempSync(join(tmpdir(), 'agy-login-copy-'))
  const chatHome = join(root, 'antigravity-chat')
  mkdirSync(join(chatHome, 'antigravity-acp'), { recursive: true })
  const userHome = join(root, 'user')
  const login = join(userHome, '.gemini', 'antigravity-cli', 'antigravity-oauth-token')
  mkdirSync(join(userHome, '.gemini', 'antigravity-cli'), { recursive: true })
  if (signedIn) {
    writeFileSync(login, 'account A')
  }
  return {
    chatHome,
    userHome,
    login,
    copy: join(chatHome, 'antigravity-acp', 'antigravity-oauth-token')
  }
}

it("copies agy's login privately for Google and removes it for a key", async () => {
  const { chatHome, userHome, copy } = homes()
  await copyAgyLoginIntoChatHome(chatHome, userHome, true)
  expect(lstatSync(copy).isSymbolicLink()).toBe(false)
  expect(readFileSync(copy, 'utf8')).toBe('account A')
  if (process.platform !== 'win32') {
    expect(statSync(copy).mode & 0o777).toBe(0o600)
  }

  await copyAgyLoginIntoChatHome(chatHome, userHome, false)
  expect(() => lstatSync(copy)).toThrow()
})

it("a running chat's refresh lands in the copy only, and the next start takes agy's current login", async () => {
  const { chatHome, userHome, login, copy } = homes()
  await copyAgyLoginIntoChatHome(chatHome, userHome, true)
  writeFileSync(copy, 'account A, refreshed by the chat')
  expect(readFileSync(login, 'utf8')).toBe('account A')

  writeFileSync(login, 'account B')
  await copyAgyLoginIntoChatHome(chatHome, userHome, true)
  expect(readFileSync(copy, 'utf8')).toBe('account B')
})

it('drops the copy once agy has signed out, leaving no login at rest', async () => {
  const { chatHome, userHome, login, copy } = homes()
  await copyAgyLoginIntoChatHome(chatHome, userHome, true)
  rmSync(login)
  await copyAgyLoginIntoChatHome(chatHome, userHome, true)
  expect(() => lstatSync(copy)).toThrow()
  expect(() => lstatSync(login)).toThrow()
})

it.skipIf(process.platform === 'win32')(
  "replaces an earlier build's link with a copy, never writing through it",
  async () => {
    const { chatHome, userHome, login, copy } = homes()
    symlinkSync(login, copy)
    await copyAgyLoginIntoChatHome(chatHome, userHome, true)
    expect(lstatSync(copy).isSymbolicLink()).toBe(false)
    writeFileSync(copy, 'refreshed')
    expect(readFileSync(login, 'utf8')).toBe('account A')
  }
)
