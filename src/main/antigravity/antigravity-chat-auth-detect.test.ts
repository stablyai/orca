import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { detectAntigravityChatAuth } from './antigravity-chat-auth-detect'

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

  it('names the project a switch to gcloud would keep', async () => {
    const gcloud = folder({
      'application_default_credentials.json': JSON.stringify({ quota_project_id: 'adc-project' })
    })
    const keyed = await detectAntigravityChatAuth(
      sources(
        { CLOUDSDK_CONFIG: gcloud },
        { config: () => ({ method: 'gemini-api-key', gcpProject: 'kept' }) }
      )
    )
    expect(keyed.adc.project).toBe('kept')
  })

  it.each([
    [true, { agySignedOut: true }],
    [false, { agySignedOut: false }],
    [null, {}]
  ])('says agy is signed out only when the host knows (%s)', async (known, expected) => {
    const detection = await detectAntigravityChatAuth(
      sources({ CLOUDSDK_CONFIG: folder() }, { agySignedOut: () => known })
    )
    expect(detection).toMatchObject(expected)
    expect('agySignedOut' in detection).toBe(known !== null)
  })

  it('reports nothing when the host has no key or ADC file', async () => {
    const detection = await detectAntigravityChatAuth(sources({ CLOUDSDK_CONFIG: folder() }))
    expect(detection.apiKey).toEqual({ available: false, source: null })
    expect(detection.adc).toEqual({ available: false, project: null })
  })

  it('survives a config being saved', async () => {
    const detection = await detectAntigravityChatAuth(
      sources(
        { CLOUDSDK_CONFIG: folder() },
        {
          config: () => {
            throw new Error('being saved')
          }
        }
      )
    )
    expect(detection.method).toBeNull()
  })
})
