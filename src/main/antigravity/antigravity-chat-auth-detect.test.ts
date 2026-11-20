import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { detectAntigravityChatAuth } from './antigravity-chat-auth-detect'
import { antigravityChatSignIn } from './antigravity-chat-account'
import { seedAntigravityChatAuth } from './antigravity-chat-saved-sign-in'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))

function folder(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'agy-detect-'))
  dirs.push(dir)
  for (const [name, contents] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true })
    writeFileSync(join(dir, name), contents)
  }
  return dir
}

const sources = (
  env: Record<string, string>,
  overrides: Partial<Parameters<typeof detectAntigravityChatAuth>[0]> = {}
): Parameters<typeof detectAntigravityChatAuth>[0] => ({
  config: () => ({ method: 'oauth-personal' }),
  launchEnv: async () => env,
  apiKeyStatus: async () => ({ saved: false, inEnvironment: Boolean(env.GEMINI_API_KEY) }),
  googleSignIn: async () => false,
  liveChats: () => 0,
  ...overrides
})

describe('detectAntigravityChatAuth', () => {
  it('finds a key in the environment and gcloud ADC with its project, and never returns the key', async () => {
    const gcloud = folder({
      'application_default_credentials.json': JSON.stringify({ quota_project_id: 'adc-project' })
    })
    const detection = await detectAntigravityChatAuth(
      sources({ GEMINI_API_KEY: 'secret-key-value', CLOUDSDK_CONFIG: gcloud })
    )
    expect(detection).toEqual({
      method: 'oauth-personal',
      googleSignIn: { personal: false, business: false },
      apiKey: { available: true, source: 'environment' },
      adc: { available: true, project: 'adc-project' },
      liveChats: 0
    })
    expect(JSON.stringify(detection)).not.toContain('secret-key-value')
  })

  it('prefers a saved key, and reads ADC from GOOGLE_APPLICATION_CREDENTIALS', async () => {
    const keys = folder({ 'sa.json': JSON.stringify({ project_id: 'sa-project' }) })
    const detection = await detectAntigravityChatAuth(
      sources(
        { GEMINI_API_KEY: 'x', GOOGLE_APPLICATION_CREDENTIALS: join(keys, 'sa.json') },
        { apiKeyStatus: async () => ({ saved: true, inEnvironment: true }) }
      )
    )
    expect(detection.apiKey).toEqual({ available: true, source: 'saved' })
    expect(detection.adc).toEqual({ available: true, project: 'sa-project' })
  })

  it("names the project a switch to gcloud would keep, but not Enterprise's", async () => {
    const gcloud = folder({
      'application_default_credentials.json': JSON.stringify({ quota_project_id: 'adc-project' })
    })
    const keyed = await detectAntigravityChatAuth(
      sources(
        { CLOUDSDK_CONFIG: gcloud },
        { config: () => ({ method: 'gemini-api-key', gcpProject: 'kept' }) }
      )
    )
    const enterprise = await detectAntigravityChatAuth(
      sources(
        { CLOUDSDK_CONFIG: gcloud },
        { config: () => ({ method: 'oauth-business', gcpProject: 'license', gcpLocation: 'us' }) }
      )
    )
    expect(keyed.adc.project).toBe('kept')
    expect(enterprise.adc.project).toBe('adc-project')
  })

  it('reports nothing when the host has no key or ADC file', async () => {
    const detection = await detectAntigravityChatAuth(sources({ CLOUDSDK_CONFIG: folder() }))
    expect(detection.apiKey).toEqual({ available: false, source: null })
    expect(detection.adc).toEqual({ available: false, project: null })
  })

  it("reports each Google method's saved sign-in, and survives a config being saved", async () => {
    const detection = await detectAntigravityChatAuth(
      sources(
        { CLOUDSDK_CONFIG: folder() },
        {
          googleSignIn: async (method) => method === 'oauth-business',
          config: () => {
            throw new Error('being saved')
          }
        }
      )
    )
    expect(detection.googleSignIn).toEqual({ personal: false, business: true })
    expect(detection.method).toBeNull()
  })
})

describe('seedAntigravityChatAuth', () => {
  beforeEach(() => antigravityChatSignIn.set({ auth: 'unknown', flow: null }))

  it('reads a saved Google token as signed in after a restart', async () => {
    const home = folder({ 'antigravity-acp/acp_token.json': '{"refresh_token":"r"}' })
    await seedAntigravityChatAuth(() => 'oauth-personal', home)
    expect(antigravityChatSignIn.get().value.auth).toBe('signedIn')
  })

  it('leaves auth unknown for a missing or unreadable token, or a key or ADC method', async () => {
    const broken = folder({ 'antigravity-acp/acp_token.json': 'not json' })
    await seedAntigravityChatAuth(() => 'oauth-personal', broken)
    await seedAntigravityChatAuth(() => 'oauth-business', broken)
    const token = folder({ 'antigravity-acp/acp_token.json': '{}' })
    await seedAntigravityChatAuth(() => 'gemini-api-key', token)
    await seedAntigravityChatAuth(() => 'agent-platform', token)
    expect(antigravityChatSignIn.get().value.auth).toBe('unknown')
  })

  it("never overrides the server's own answer", async () => {
    const home = folder({ 'antigravity-acp/acp_token.json': '{}' })
    const seeded = seedAntigravityChatAuth(() => 'oauth-personal', home)
    antigravityChatSignIn.set({ auth: 'signedOut', flow: null })
    await seeded
    expect(antigravityChatSignIn.get().value.auth).toBe('signedOut')
  })
  it('waits for a running sign-in flow to answer instead of seeding', async () => {
    const home = folder({ 'antigravity-acp/acp_token.json': '{}' })
    antigravityChatSignIn.set({
      auth: 'unknown',
      flow: { flowId: 'f', owner: 'o', phase: 'waiting' }
    })
    await seedAntigravityChatAuth(() => 'oauth-personal', home)
    expect(antigravityChatSignIn.get().value.auth).toBe('unknown')
  })
})
