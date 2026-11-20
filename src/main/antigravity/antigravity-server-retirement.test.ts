import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { retireAntigravityServerLeftovers } from './antigravity-server-retirement'

let data = ''
afterEach(() => rmSync(data, { recursive: true, force: true }))

it("removes the retired server's releases, Google tokens and temp folders, never its chats", async () => {
  data = mkdtempSync(join(tmpdir(), 'orca-retire-'))
  const files = (paths: string[]) =>
    paths.map((path) => {
      const full = join(data, path)
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, 'x')
      return full
    })
  const gone = files([
    'agent-runtimes/antigravity/1.5.0/agy_acp_server.par',
    'antigravity-chat/antigravity-acp/acp_token.json',
    'antigravity-chat/antigravity-acp/acp_business_token.json',
    'antigravity-chat/sign-in/run-1/home/x',
    'acp-temp/antigravity/run-1/x'
  ])
  const kept = files([
    'agent-runtimes/agy/1.5.13/agy',
    'antigravity-chat/antigravity-acp/conversations/c.db',
    'antigravity-chat/antigravity-acp/brain/c/x',
    'antigravity-chat/antigravity-acp/settings.json',
    'antigravity-chat/gemini-api-key.enc'
  ])

  await retireAntigravityServerLeftovers(data)

  expect(gone.filter((path) => existsSync(path))).toEqual([])
  expect(kept.filter((path) => !existsSync(path))).toEqual([])
  expect(existsSync(join(data, 'agent-runtimes', 'antigravity'))).toBe(false)
})
