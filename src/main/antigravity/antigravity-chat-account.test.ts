import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { AntigravityChatAuthConfig } from '../../shared/agent-accounts/antigravity/antigravity-chat-auth-config'
import { antigravityChatAccount } from './antigravity-chat-account'

let root = ''
afterEach(() => rmSync(root, { recursive: true, force: true }))

async function prepare(auth: AntigravityChatAuthConfig, extra: Record<string, string> = {}) {
  root = mkdtempSync(join(tmpdir(), 'agy-chat-home-'))
  const home = join(root, 'antigravity-chat')
  await antigravityChatAccount.prepare({ GEMINI_HOME: home, HOME: root, ...extra }, auth)
  return readFileSync(join(home, 'antigravity-acp', 'settings.json'), 'utf8')
}

it("leaves Google to agy's own saved login", async () => {
  expect(await prepare({ method: 'oauth-personal' })).toBe('{}')
})

it('names the key method without writing the key', async () => {
  const settings = await prepare({ method: 'gemini-api-key' }, { GEMINI_API_KEY: 'secret-key' })
  expect(settings).toBe('{"auth":{"type":"gemini-api-key"}}')
})

it('names gcloud with the project its credentials name', async () => {
  const adc = join(tmpdir(), `adc-${process.pid}.json`)
  writeFileSync(adc, JSON.stringify({ quota_project_id: 'adc-project' }))
  try {
    const settings = await prepare(
      { method: 'agent-platform' },
      { GOOGLE_APPLICATION_CREDENTIALS: adc }
    )
    expect(JSON.parse(settings)).toEqual({
      auth: { type: 'agent-platform' },
      gcp: { project: 'adc-project', location: 'global' }
    })
  } finally {
    rmSync(adc, { force: true })
  }
})

it.each<[string, AntigravityChatAuthConfig]>([
  ['a key method with no key', { method: 'gemini-api-key' }],
  ['gcloud with no login', { method: 'agent-platform', gcpProject: 'p' }]
])(
  "refuses %s as not signed in to Orca's settings, never falling back to agy's login",
  async (_case, auth) => {
    await expect(
      prepare(auth, { GOOGLE_APPLICATION_CREDENTIALS: join(tmpdir(), 'no-such-adc.json') })
    ).rejects.toMatchObject({ reason: 'notSignedIn', account: 'managed' })
  }
)
