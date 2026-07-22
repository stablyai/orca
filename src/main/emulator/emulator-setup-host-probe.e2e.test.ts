import { describe, expect, it } from 'vitest'
import { inspectAndroidSetupFromHost, inspectIosSetupFromHost } from './emulator-setup-host-probe'

const runHostProbe = process.env.ORCA_EMULATOR_SETUP_E2E === '1' ? describe : describe.skip

runHostProbe('mobile emulator host setup probe', () => {
  it('classifies the real host without claiming unusable iOS tooling is ready', async () => {
    const ios = await inspectIosSetupFromHost()
    console.info(`iOS setup state: ${ios.state} (${ios.message})`)
    expect(ios.state).toMatch(
      /^(unsupported|xcode-missing|xcode-selection-required|xcode-first-launch-required|simulator-runtime-missing|simulator-device-missing|ready|error)$/
    )
    if (ios.state === 'ready') {
      expect(ios.devices.length).toBeGreaterThan(0)
    }
    if (ios.state === 'xcode-selection-required') {
      expect(ios.recommendedXcode?.developerDir).toMatch(/\.app\/Contents\/Developer$/)
    }
  })

  it('classifies the real Android SDK component boundary', () => {
    const android = inspectAndroidSetupFromHost({
      available: false,
      devices: [],
      message: 'No Android devices or AVDs found.'
    })
    console.info(`Android setup state: ${android.state} (${android.message})`)
    expect(android.state).toMatch(
      /^(sdk-missing|sdk-invalid|platform-tools-missing|emulator-missing|system-image-missing|device-missing|ready|error)$/
    )
    if (android.state === 'ready') {
      expect(android.components).toEqual({
        platformTools: true,
        emulator: true,
        systemImages: true
      })
    }
  })
})
