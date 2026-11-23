import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  agyOrcaHomeCredentialPresent,
  type AgyOrcaHomeCredentialProbe
} from './antigravity-agy-orca-home-credential'

function probe(
  files: string[] = [],
  overrides: Partial<AgyOrcaHomeCredentialProbe> = {}
): AgyOrcaHomeCredentialProbe {
  return {
    platform: 'darwin',
    savedKey: async () => null,
    isFile: async (path) => files.includes(path),
    productName: async () => '',
    ...overrides
  }
}

const adc = (...parts: string[]) => join(...parts, 'application_default_credentials.json')

describe('a Gemini API key', () => {
  it('is here when GEMINI_API_KEY is set or the saved key decrypts', async () => {
    expect(
      await agyOrcaHomeCredentialPresent('gemini-api-key', { GEMINI_API_KEY: 'k' }, probe())
    ).toBe(true)
    const saved = probe([], { savedKey: async () => 'k' })
    expect(await agyOrcaHomeCredentialPresent('gemini-api-key', {}, saved)).toBe(true)
  })

  it('is missing when neither is, or the variable is blank', async () => {
    expect(
      await agyOrcaHomeCredentialPresent('gemini-api-key', { GEMINI_API_KEY: ' ' }, probe())
    ).toBe(false)
  })
})

describe('gcloud (Google Agent Platform)', () => {
  const home = '/home/u'

  it('is here with the ADC file gcloud writes under HOME, or under CLOUDSDK_CONFIG', async () => {
    const env = { HOME: home }
    expect(
      await agyOrcaHomeCredentialPresent(
        'agent-platform',
        env,
        probe([adc(home, '.config', 'gcloud')])
      )
    ).toBe(true)
    const config = { HOME: home, CLOUDSDK_CONFIG: '/etc/gc' }
    expect(
      await agyOrcaHomeCredentialPresent('agent-platform', config, probe([adc('/etc/gc')]))
    ).toBe(true)
  })

  it("is here on Windows with the file under APPDATA's gcloud folder", async () => {
    const env = { USERPROFILE: 'C:\\Users\\u', APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }
    const files = [adc('C:\\Users\\u\\AppData\\Roaming', 'gcloud')]
    expect(
      await agyOrcaHomeCredentialPresent('agent-platform', env, probe(files, { platform: 'win32' }))
    ).toBe(true)
  })

  it('reads only the file GOOGLE_APPLICATION_CREDENTIALS names, as Google’s libraries do', async () => {
    const files = ['/keys/sa.json', adc(home, '.config', 'gcloud')]
    const named = (path: string) => ({ HOME: home, GOOGLE_APPLICATION_CREDENTIALS: path })
    expect(
      await agyOrcaHomeCredentialPresent('agent-platform', named('/keys/sa.json'), probe(files))
    ).toBe(true)
    expect(
      await agyOrcaHomeCredentialPresent('agent-platform', named('/keys/gone.json'), probe(files))
    ).toBe(false)
  })

  it('is missing without any ADC file on macOS and Windows, whatever the machine', async () => {
    const google = { productName: async () => 'Google Compute Engine' }
    expect(
      await agyOrcaHomeCredentialPresent('agent-platform', { HOME: home }, probe([], google))
    ).toBe(false)
    const metadata = { HOME: home, GCE_METADATA_HOST: '169.254.169.254' }
    expect(
      await agyOrcaHomeCredentialPresent(
        'agent-platform',
        metadata,
        probe([], { platform: 'win32' })
      )
    ).toBe(false)
  })

  it('counts a plausible metadata server on Linux, which has no shared login to fall back to', async () => {
    const linux = (overrides: Partial<AgyOrcaHomeCredentialProbe> = {}) =>
      probe([], { platform: 'linux', ...overrides })
    const env = { HOME: home }
    expect(
      await agyOrcaHomeCredentialPresent(
        'agent-platform',
        env,
        linux({ productName: async () => 'Google Compute Engine\n' })
      )
    ).toBe(true)
    expect(
      await agyOrcaHomeCredentialPresent(
        'agent-platform',
        { ...env, GCE_METADATA_HOST: 'metadata' },
        linux()
      )
    ).toBe(true)
    expect(await agyOrcaHomeCredentialPresent('agent-platform', env, linux())).toBe(false)
  })
})
