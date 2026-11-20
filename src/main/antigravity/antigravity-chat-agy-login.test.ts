import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { linkAgyLoginIntoChatHome } from './antigravity-chat-agy-login'

let root = ''
afterEach(() => rmSync(root, { recursive: true, force: true }))

function homes(signedIn = true) {
  root = mkdtempSync(join(tmpdir(), 'agy-login-link-'))
  const chatHome = join(root, 'antigravity-chat')
  const folder = join(chatHome, 'antigravity-acp')
  mkdirSync(folder, { recursive: true })
  const userHome = join(root, 'user')
  const target = join(userHome, '.gemini', 'antigravity-cli', 'antigravity-oauth-token')
  if (signedIn) {
    mkdirSync(join(userHome, '.gemini', 'antigravity-cli'), { recursive: true })
    writeFileSync(target, 'agy login')
  }
  return {
    chatHome,
    userHome,
    target,
    link: join(folder, 'antigravity-oauth-token'),
    aside: join(folder, 'antigravity-oauth-token.orca-replaced')
  }
}

it("points Orca's chat home at agy's own login file for Google, and drops it for a key", async () => {
  const { chatHome, userHome, link, target } = homes()
  await linkAgyLoginIntoChatHome(chatHome, userHome, true, 'linux')
  expect(readlinkSync(link)).toBe(target)

  await linkAgyLoginIntoChatHome(chatHome, userHome, false, 'linux')
  expect(() => lstatSync(link)).toThrow()
})

it("sets a login file found in the chat home aside and links agy's login in its place", async () => {
  const { chatHome, userHome, link, target, aside } = homes()
  writeFileSync(link, 'stale copy')
  await linkAgyLoginIntoChatHome(chatHome, userHome, true, 'linux')
  expect(readlinkSync(link)).toBe(target)
  expect(readFileSync(aside, 'utf8')).toBe('stale copy')
})

it('keeps a login file for a key or gcloud, which never read it', async () => {
  const { chatHome, userHome, link } = homes()
  writeFileSync(link, 'stale copy')
  await linkAgyLoginIntoChatHome(chatHome, userHome, false, 'linux')
  expect(readFileSync(link, 'utf8')).toBe('stale copy')
})

it('re-points a link to another file', async () => {
  const { chatHome, userHome, link, target } = homes()
  symlinkSync(join(root, 'elsewhere'), link)
  await linkAgyLoginIntoChatHome(chatHome, userHome, true, 'linux')
  expect(readlinkSync(link)).toBe(target)
})

it('makes no link while agy has no login file, and removes one left dangling', async () => {
  const { chatHome, userHome, link, target } = homes(false)
  await linkAgyLoginIntoChatHome(chatHome, userHome, true, 'linux')
  expect(() => lstatSync(link)).toThrow()

  symlinkSync(target, link)
  await linkAgyLoginIntoChatHome(chatHome, userHome, true, 'linux')
  expect(() => lstatSync(link)).toThrow()
})

it("refreshes a Windows copy only when agy's login changed", async () => {
  const { chatHome, userHome, link, target, aside } = homes()
  writeFileSync(link, 'agy login')
  await linkAgyLoginIntoChatHome(chatHome, userHome, true, 'win32')
  expect(() => lstatSync(aside)).toThrow()

  writeFileSync(target, 'new login')
  await linkAgyLoginIntoChatHome(chatHome, userHome, true, 'win32')
  expect(readFileSync(link, 'utf8')).toBe('new login')
  expect(readFileSync(aside, 'utf8')).toBe('agy login')
})
