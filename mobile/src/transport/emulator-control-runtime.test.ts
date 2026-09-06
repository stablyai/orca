import { describe, expect, it } from 'vitest'
import { emulatorControlRuntime } from '../../scripts/emulator-control-runtime.mjs'

describe('emulator control runtime selection', () => {
  it('keeps ordinary emulator commands on the paired runtime', () => {
    const pairingRuntime = { env: { ORCA_USER_DATA_PATH: '/paired' } }

    expect(emulatorControlRuntime(pairingRuntime)).toBe(pairingRuntime)
  })

  it('routes E2E emulator commands through a stable controller profile', () => {
    const pairingRuntime = {
      pairingUrl: 'orca://pair',
      env: { ORCA_USER_DATA_PATH: '/paired', KEEP: 'yes' }
    }

    expect(emulatorControlRuntime(pairingRuntime, '/controller')).toEqual({
      pairingUrl: 'orca://pair',
      env: {
        ORCA_USER_DATA_PATH: '/controller',
        ORCA_DEV_USER_DATA_PATH: '/controller',
        KEEP: 'yes'
      }
    })
  })
})
