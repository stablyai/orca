import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const keyFile = vi.hoisted(() => ({ saved: false }))
vi.mock('./antigravity-chat-api-key-store', () => ({
  hasAntigravityChatApiKey: async () => keyFile.saved
}))

const { assertAntigravityChatCredential, plausibleMetadataCredentials } =
  await import('./antigravity-chat-credential')
const { antigravitySignInFailure, SIGN_IN_FAILED } = await import('./antigravity-sign-in-failure')

let home = ''
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'orca-chat-home-'))
  mkdirSync(join(home, 'antigravity-acp'), { recursive: true })
  writeFileSync(join(home, 'antigravity-acp', 'acp_token.json'), '{}')
  await plausibleMetadataCredentials({}, async () => 'not a cloud machine')
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

async function signInRefusal(...args: Parameters<typeof assertAntigravityChatCredential>) {
  return assertAntigravityChatCredential(...args).then(
    () => undefined,
    (error: unknown) => error
  )
}

it("tells Settings' Sign in that no gcloud login was found, not that Google sign-in failed", async () => {
  const refusal = await signInRefusal(
    { method: 'agent-platform', gcpProject: 'p' },
    { GOOGLE_APPLICATION_CREDENTIALS: '/nonexistent/adc.json' },
    home
  )
  expect(antigravitySignInFailure(refusal)).toContain('No gcloud login was found')
})

it("tells Settings' Sign in that the saved key can't be read", async () => {
  keyFile.saved = true
  const refusal = await signInRefusal({ method: 'gemini-api-key' }, {}, home)
  expect(antigravitySignInFailure(refusal)).toContain("can't be read")
  expect(antigravitySignInFailure(new Error('other'))).toBe(SIGN_IN_FAILED)
})
