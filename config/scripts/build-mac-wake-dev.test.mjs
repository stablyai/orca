import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createWakeDevBuildEnvironment, verifyWakeDevAppSignatures } from './build-mac-wake-dev.mjs'

describe('Orca Wake Dev mac build profile', () => {
  it('pins the separate flavor and removes release-channel authority', () => {
    const env = createWakeDevBuildEnvironment({
      PATH: '/usr/bin',
      ORCA_MAC_RELEASE: '1',
      ORCA_MAC_HOURLY: '1',
      ORCA_MAC_ADHOC: '1',
      ORCA_BUILD_IDENTITY: 'stable',
      ORCA_POSTHOG_WRITE_KEY: 'must-not-ship',
      ORCA_DIAGNOSTICS_TOKEN_URL: 'https://must-not-ship.invalid'
    })

    expect(env).toMatchObject({
      ORCA_WAKE_DEV_BUILD: '1',
      ORCA_COMPUTER_MACOS_BUNDLE_ID: 'com.ram4dev.orca-wake-dev.computer-use',
      ORCA_COMPUTER_MACOS_SIGN_IDENTITY: '-',
      ORCA_NOTIFICATION_STATUS_SIGN_IDENTITY: '-',
      CSC_IDENTITY_AUTO_DISCOVERY: 'false'
    })
    expect(env.ORCA_MAC_RELEASE).toBeUndefined()
    expect(env.ORCA_MAC_HOURLY).toBeUndefined()
    expect(env.ORCA_MAC_ADHOC).toBeUndefined()
    expect(env.ORCA_BUILD_IDENTITY).toBeUndefined()
    expect(env.ORCA_POSTHOG_WRITE_KEY).toBeUndefined()
    expect(env.ORCA_DIAGNOSTICS_TOKEN_URL).toBeUndefined()
  })

  it('ships a wake-only CLI launcher with the isolated profile', async () => {
    const launcher = await readFile(resolve('resources/darwin/bin/orca-wake'), 'utf8')

    expect(launcher).toContain('MacOS/Orca Wake Dev')
    expect(launcher).toContain('Application Support/orca-wake-dev')
    expect(launcher).not.toContain('MacOS/Orca"')
  })

  it('verifies both packaged app bundles before reporting a successful build', () => {
    const calls = []

    verifyWakeDevAppSignatures('/tmp/wake-dev-output', (...args) => calls.push(args))

    expect(calls).toEqual([
      [
        'codesign',
        ['--verify', '--deep', '--strict', '/tmp/wake-dev-output/mac/Orca Wake Dev.app'],
        { stdio: 'inherit' }
      ],
      [
        'codesign',
        ['--verify', '--deep', '--strict', '/tmp/wake-dev-output/mac-arm64/Orca Wake Dev.app'],
        { stdio: 'inherit' }
      ]
    ])
  })
})
