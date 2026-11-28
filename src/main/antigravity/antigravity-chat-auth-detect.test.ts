import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, expect, it, vi } from 'vitest'
import { agyCredentialPresence } from './agy-credential-presence'
import { detectAntigravityChatAuth } from './antigravity-chat-auth-detect'

vi.mock('./agy-credential-presence', () => ({ agyCredentialPresence: vi.fn() }))

const home = tmpdir()
const detect = () =>
  detectAntigravityChatAuth({
    config: () => ({ method: 'oauth-personal' }),
    // No ADC file here, so only the Google login is in question.
    launchEnv: async () => ({
      HOME: home,
      GOOGLE_APPLICATION_CREDENTIALS: join(home, 'orca-test-no-adc.json')
    }),
    apiKeyStatus: async () => ({ saved: false, inEnvironment: false }),
    liveChats: () => 0
  })

beforeEach(() => vi.mocked(agyCredentialPresence).mockReset())

// Incident replay: agy's keychain item could not be read in time ("locked": no answer). That says
// nothing about the login, so detection must not read as "no Google login on this host".
it('marks a Google login it could not read as unchecked, not absent', async () => {
  vi.mocked(agyCredentialPresence).mockResolvedValue('locked')
  const detection = await detect()
  expect(detection.googleSignIn.personal).toBe(false)
  expect(detection.googleSignIn.personalUnchecked).toBe(true)
})

it('reads a definitively absent login as absent, with nothing unchecked', async () => {
  vi.mocked(agyCredentialPresence).mockResolvedValue('absent')
  const detection = await detect()
  expect(detection.googleSignIn).toEqual({ personal: false, business: false })
})

it('reads a present login as present', async () => {
  vi.mocked(agyCredentialPresence).mockResolvedValue('present')
  const detection = await detect()
  expect(detection.googleSignIn).toEqual({ personal: true, business: false })
})
