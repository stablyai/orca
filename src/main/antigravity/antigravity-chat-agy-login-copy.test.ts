import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { copyAgyLoginIntoChatHome, syncAgyLoginCopy } from './antigravity-chat-agy-login-copy'

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
    writeFileSync(login, '{"account":"A"}')
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
  expect(readFileSync(copy, 'utf8')).toBe('{"account":"A"}')
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
  expect(readFileSync(login, 'utf8')).toBe('{"account":"A"}')

  writeFileSync(login, '{"account":"B"}')
  await copyAgyLoginIntoChatHome(chatHome, userHome, true)
  expect(readFileSync(copy, 'utf8')).toBe('{"account":"B"}')
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
    expect(readFileSync(login, 'utf8')).toBe('{"account":"A"}')
  }
)

it("keeps a good copy while agy's file reads empty or cut short mid-rewrite", async () => {
  const { chatHome, userHome, login, copy } = homes()
  await copyAgyLoginIntoChatHome(chatHome, userHome, true)
  for (const partial of ['', '{"account":']) {
    writeFileSync(login, partial)
    await copyAgyLoginIntoChatHome(chatHome, userHome, true)
    expect(readFileSync(copy, 'utf8')).toBe('{"account":"A"}')
  }
})

it('removes temp files a crash left holding the login, and leaves none of its own', async () => {
  const { chatHome, userHome } = homes()
  const folder = join(chatHome, 'antigravity-acp')
  writeFileSync(join(folder, 'antigravity-oauth-token.123.1700000000000.tmp'), 'old login')
  await Promise.all([
    copyAgyLoginIntoChatHome(chatHome, userHome, true),
    copyAgyLoginIntoChatHome(chatHome, userHome, true)
  ])
  expect(readdirSync(folder).filter((name) => name.endsWith('.tmp'))).toEqual([])
})

it('syncs outside a chat start: drops the copy after a sign-out or for a key, and creates no chat home', async () => {
  const { chatHome, userHome, login, copy } = homes()
  const data = join(chatHome, '..')
  await syncAgyLoginCopy({ method: 'oauth-personal' }, data, userHome)
  expect(readFileSync(copy, 'utf8')).toBe('{"account":"A"}')
  await syncAgyLoginCopy({ method: 'gemini-api-key' }, data, userHome)
  expect(() => lstatSync(copy)).toThrow()

  await syncAgyLoginCopy({ method: 'oauth-personal' }, data, userHome)
  rmSync(login)
  await syncAgyLoginCopy({ method: 'oauth-personal' }, data, userHome)
  expect(() => lstatSync(copy)).toThrow()

  const empty = mkdtempSync(join(tmpdir(), 'agy-no-chat-home-'))
  await syncAgyLoginCopy({ method: 'oauth-personal' }, empty, userHome)
  expect(readdirSync(empty)).toEqual([])
  rmSync(empty, { recursive: true, force: true })
})
