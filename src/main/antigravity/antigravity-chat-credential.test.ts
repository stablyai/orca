import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { assertAntigravityChatCredential } from './antigravity-chat-credential'

let folder = ''
afterEach(() => rmSync(folder, { recursive: true, force: true }))

it.each([
  ['a Gemini API key chat with no key', { method: 'gemini-api-key' as const }, {}],
  [
    'a gcloud chat with no ADC file',
    { method: 'agent-platform' as const, gcpProject: 'p' },
    { GOOGLE_APPLICATION_CREDENTIALS: '/nonexistent/adc.json' }
  ]
])('refuses %s as not signed in to Orca, before the server starts', async (_case, auth, env) => {
  await expect(assertAntigravityChatCredential(auth, env)).rejects.toMatchObject({
    reason: 'notSignedIn',
    account: 'managed'
  })
})

it('lets a key, an ADC file and Google through', async () => {
  folder = mkdtempSync(join(tmpdir(), 'orca-adc-'))
  const adc = join(folder, 'adc.json')
  writeFileSync(adc, '{}')
  await expect(
    assertAntigravityChatCredential({ method: 'gemini-api-key' }, { GEMINI_API_KEY: 'k' })
  ).resolves.toBeUndefined()
  await expect(
    assertAntigravityChatCredential(
      { method: 'agent-platform', gcpProject: 'p' },
      { GOOGLE_APPLICATION_CREDENTIALS: adc }
    )
  ).resolves.toBeUndefined()
  await expect(
    assertAntigravityChatCredential({ method: 'oauth-personal' }, {})
  ).resolves.toBeUndefined()
})
