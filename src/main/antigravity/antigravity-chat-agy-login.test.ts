import { lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { linkAgyLoginIntoChatHome } from './antigravity-chat-agy-login'

let root = ''
afterEach(() => rmSync(root, { recursive: true, force: true }))

function homes() {
  root = mkdtempSync(join(tmpdir(), 'agy-login-link-'))
  const chatHome = join(root, 'antigravity-chat')
  mkdirSync(join(chatHome, 'antigravity-acp'), { recursive: true })
  return {
    chatHome,
    userHome: join(root, 'user'),
    link: join(chatHome, 'antigravity-acp', 'antigravity-oauth-token')
  }
}

it("points Orca's chat home at agy's own login file for Google, and drops it for a key", async () => {
  const { chatHome, userHome, link } = homes()
  await linkAgyLoginIntoChatHome(chatHome, userHome, true, 'linux')
  expect(readlinkSync(link)).toBe(
    join(userHome, '.gemini', 'antigravity-cli', 'antigravity-oauth-token')
  )

  await linkAgyLoginIntoChatHome(chatHome, userHome, false, 'linux')
  expect(() => lstatSync(link)).toThrow()
})

it('leaves a login file agy saved in the chat home itself', async () => {
  const { chatHome, userHome, link } = homes()
  writeFileSync(link, 'saved here')
  await linkAgyLoginIntoChatHome(chatHome, userHome, true, 'linux')
  await linkAgyLoginIntoChatHome(chatHome, userHome, false, 'linux')
  expect(lstatSync(link).isSymbolicLink()).toBe(false)
})
