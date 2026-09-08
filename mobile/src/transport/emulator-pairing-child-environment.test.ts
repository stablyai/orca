import { describe, expect, it } from 'vitest'
import { createEmulatorPairingChildEnvironment } from '../../scripts/emulator-pairing-child-environment.mjs'

describe('createEmulatorPairingChildEnvironment', () => {
  it('uses the disposable profile without inheriting real agent homes', () => {
    expect(
      createEmulatorPairingChildEnvironment({
        inheritedEnvironment: {
          CODEX_HOME: '/real/.codex',
          ORCA_CODEX_HOME: '/real/.codex',
          PATH: '/bin'
        },
        environment: { ORCA_E2E_MOBILE_AGENT_HISTORY_FIXTURE: '1' },
        userData: '/run/userData',
        homeDir: '/run/home'
      })
    ).toEqual({
      PATH: '/bin',
      ORCA_E2E_MOBILE_AGENT_HISTORY_FIXTURE: '1',
      ORCA_DEV_USER_DATA_PATH: '/run/userData',
      ORCA_E2E_USER_DATA_DIR: '/run/userData',
      ORCA_E2E_HOME_DIR: '/run/home',
      HOME: '/run/home',
      USERPROFILE: '/run/home'
    })
  })
})
