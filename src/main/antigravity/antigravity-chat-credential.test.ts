import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const keyFile = vi.hoisted(() => ({ saved: false }))
vi.mock('./antigravity-chat-api-key-store', () => ({
  hasAntigravityChatApiKey: async () => keyFile.saved
}))

const {
  assertAntigravityChatCredential,
  envValue,
  forgetPlausibleMetadataCredentials,
  plausibleMetadataCredentials
} = await import('./antigravity-chat-credential')

let home = ''
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orca-chat-home-'))
  keyFile.saved = false
  forgetPlausibleMetadataCredentials()
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

function saveGoogleLogin(): void {
  mkdirSync(join(home, 'antigravity-acp'), { recursive: true })
  writeFileSync(join(home, 'antigravity-acp', 'acp_token.json'), '{"refresh_token":"r"}')
}
const noAdc = { GOOGLE_APPLICATION_CREDENTIALS: '/nonexistent/adc.json' }
const gcloud = { method: 'agent-platform' as const, gcpProject: 'p' }

it('launches a key or gcloud chat without its credential when no Google login is saved', async () => {
  await expect(
    assertAntigravityChatCredential({ method: 'gemini-api-key' }, {}, home)
  ).resolves.toBeUndefined()
  await expect(assertAntigravityChatCredential(gcloud, noAdc, home)).resolves.toBeUndefined()
})

it('refuses a missing key while a Google login is saved in that chat home', async () => {
  saveGoogleLogin()
  await expect(
    assertAntigravityChatCredential({ method: 'gemini-api-key' }, {}, home)
  ).rejects.toMatchObject({
    reason: 'notSignedIn',
    account: 'managed',
    message: expect.stringContaining('No Gemini API key is saved')
  })
})

it("says a saved key can't be read rather than that none is saved", async () => {
  saveGoogleLogin()
  keyFile.saved = true
  await expect(
    assertAntigravityChatCredential({ method: 'gemini-api-key' }, {}, home)
  ).rejects.toMatchObject({ message: expect.stringContaining("can't be read") })
})

it('launches gcloud on Google Cloud, where ADC comes from the metadata server', async () => {
  saveGoogleLogin()
  await expect(
    assertAntigravityChatCredential(
      gcloud,
      { ...noAdc, GCE_METADATA_HOST: '169.254.169.254' },
      home
    )
  ).resolves.toBeUndefined()
  forgetPlausibleMetadataCredentials()
  expect(await plausibleMetadataCredentials({}, async () => 'Google Compute Engine\n')).toBe(true)
})

it('refuses gcloud without an ADC file off Google Cloud while a Google login is saved', async () => {
  saveGoogleLogin()
  await plausibleMetadataCredentials({}, async () => 'MacBookPro18,1')
  await expect(assertAntigravityChatCredential(gcloud, noAdc, home)).rejects.toMatchObject({
    reason: 'notSignedIn'
  })
})

it('leaves a relative ADC path to the server, which resolves it in its own folder', async () => {
  saveGoogleLogin()
  await plausibleMetadataCredentials({}, async () => 'none')
  await expect(
    assertAntigravityChatCredential(gcloud, { GOOGLE_APPLICATION_CREDENTIALS: 'adc.json' }, home)
  ).resolves.toBeUndefined()
})

it('reads Windows environment names case-insensitively', () => {
  expect(envValue({ Gemini_Api_Key: 'k' }, 'GEMINI_API_KEY', 'win32')).toBe('k')
  expect(envValue({ Gemini_Api_Key: 'k' }, 'GEMINI_API_KEY', 'linux')).toBeUndefined()
})
