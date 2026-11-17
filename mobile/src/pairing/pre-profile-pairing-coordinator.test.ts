import { describe, expect, it, vi } from 'vitest'

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED' }))
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {} }))

import { RuntimeAccessLinkError } from './mobile-pairing-offer-scope'
import { startPreProfilePairing } from './pre-profile-pairing-coordinator'

describe('startPreProfilePairing', () => {
  it('refuses an access link meant for another Orca client', async () => {
    const attempt = startPreProfilePairing({
      offer: {
        v: 2,
        endpoint: 'ws://100.64.1.20:6768',
        deviceToken: 'runtime-ticket',
        publicKeyB64: 'cHVibGljLWtleQ==',
        scope: 'runtime'
      },
      timeoutMs: 30_000,
      dependencies: {
        resolveHostIdentity: async () => ({ id: 'host-1', name: 'Server' }),
        connectDirect: () => {
          throw new Error('dialed the host')
        }
      }
    })

    await expect(attempt.result).rejects.toBeInstanceOf(RuntimeAccessLinkError)
  })
})
