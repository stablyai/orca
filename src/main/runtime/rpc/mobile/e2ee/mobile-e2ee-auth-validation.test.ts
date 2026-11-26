import { afterEach, expect, it, vi } from 'vitest'
import { authenticateMobileE2EE } from './mobile-e2ee-auth-validation'
import type { DesktopMobileE2EEV2Session } from './mobile-e2ee-v2-desktop-session'

afterEach(() => vi.unstubAllEnvs())

it('over Relay, takes capabilities on token auth from a paired computer only, never a phone', () => {
  vi.stubEnv('ORCA_TEST_RUNTIME_RELAY_PAIRING', '1')
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: token auth reads only the transcript hash
  const v2Session = { transcriptHashB64: 'transcript' } as DesktopMobileE2EEV2Session
  const plaintext = JSON.stringify({
    type: 'e2ee_auth',
    v: 2,
    transcriptHashB64: 'transcript',
    deviceToken: 'token',
    clientCapabilities: ['rpc.binary-channels.v1']
  })
  const auth = (scope: string) =>
    authenticateMobileE2EE({
      plaintext,
      v2Session,
      transport: 'relay',
      resolveDevice: () => ({ deviceToken: 'token', scope })
    })
  expect(auth('runtime')).toMatchObject({
    ok: true,
    clientCapabilities: ['rpc.binary-channels.v1']
  })
  expect(auth('mobile')).toEqual({ ok: false, code: 'bad_auth' })
})
