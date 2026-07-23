import { describe, expect, it } from 'vitest'
import { buildHeadlessPairingRuntimeEnvironment } from '../scripts/start-emulator-pairing-runtime.mjs'

describe('mobile emulator pairing runtime environment', () => {
  it('isolates writable homes without hiding login-shell transcripts', () => {
    expect(
      buildHeadlessPairingRuntimeEnvironment({
        baseEnv: { PATH: '/bin' },
        userData: '/tmp/run/userData',
        isolatedHomeDir: '/tmp/run/home',
        transcriptHomeDir: '/Users/ada'
      })
    ).toMatchObject({
      PATH: '/bin',
      ORCA_E2E_USER_DATA_DIR: '/tmp/run/userData',
      ORCA_E2E_HOME_DIR: '/tmp/run/home',
      ORCA_DEV_USER_DATA_PATH: '/tmp/run/userData',
      ORCA_NATIVE_CHAT_TRANSCRIPT_HOME_DIR: '/Users/ada',
      HOME: '/tmp/run/home',
      USERPROFILE: '/tmp/run/home'
    })
  })
})
