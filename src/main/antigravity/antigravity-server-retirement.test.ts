import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  retireAntigravityServerLeftovers,
  scheduleAntigravityServerRetirement
} from './antigravity-server-retirement'

let data = ''
afterEach(() => rmSync(data, { recursive: true, force: true }))

it("removes only the retired server's temp folders, keeping its releases, tokens and chats", async () => {
  data = mkdtempSync(join(tmpdir(), 'orca-retire-'))
  const files = (paths: string[]) =>
    paths.map((path) => {
      const full = join(data, path)
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, 'x')
      return full
    })
  const gone = files(['antigravity-chat/sign-in/run-1/home/x', 'acp-temp/antigravity/run-1/x'])
  // Kept for going back to an older Orca, which still runs the server with these.
  const kept = files([
    'agent-runtimes/antigravity/1.5.0/agy_acp_server.par',
    'antigravity-chat/antigravity-acp/acp_token.json',
    'antigravity-chat/antigravity-acp/acp_business_token.json',
    'agent-runtimes/agy/1.5.13/agy',
    'antigravity-chat/antigravity-acp/conversations/c.db',
    'antigravity-chat/antigravity-acp/brain/c/x',
    'antigravity-chat/antigravity-acp/settings.json',
    'antigravity-chat/gemini-api-key.enc'
  ])

  await retireAntigravityServerLeftovers(data)

  expect(gone.filter((path) => existsSync(path))).toEqual([])
  expect(kept.filter((path) => !existsSync(path))).toEqual([])
})

it("finds the server's /tmp folder only under a parent this user owns privately", async () => {
  const { chmodSync, mkdirSync: mkdir } = await import('node:fs')
  const { antigravityServerShortTemp } = await import('./antigravity-server-retirement')
  data = mkdtempSync(join(tmpdir(), 'orca-retire-tmp-'))
  const uid = process.getuid?.()
  if (uid === undefined) {
    return
  }
  const parent = join(data, `oacp-${uid}`)
  mkdir(parent, { mode: 0o700 })
  chmodSync(parent, 0o700)
  // The hash of the server's old temp root, `<data>/acp-temp/antigravity`.
  expect(await antigravityServerShortTemp('/data', uid, data)).toBe(join(parent, '328f9237'))
  chmodSync(parent, 0o777)
  expect(await antigravityServerShortTemp('/data', uid, data)).toBeNull()
  expect(await antigravityServerShortTemp('/data', uid + 1, data)).toBeNull()
})

it("runs the launch's login-copy upkeep off the startup path, and a failure there is only logged", async () => {
  vi.useFakeTimers()
  try {
    const upkeep = vi.fn(async () => {
      throw new Error('store not ready')
    })
    scheduleAntigravityServerRetirement(join(tmpdir(), 'no-orca-data'), upkeep)
    expect(upkeep).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(upkeep).toHaveBeenCalledTimes(1)
  } finally {
    vi.useRealTimers()
  }
})
