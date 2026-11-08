import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { assertMacGuiLaunchAllowed } from './macos-gui-launch-preflight.mjs'

describe('macOS GUI launch preflight', () => {
  it('refuses darwin seatbelt even for hidden/headless launches', () => {
    expect(() =>
      assertMacGuiLaunchAllowed({
        platform: 'darwin',
        env: { CODEX_SANDBOX: 'seatbelt', ORCA_BACKGROUND_LAUNCH: '1', ORCA_E2E_HEADLESS: '1' }
      })
    ).toThrow(/outside the Codex sandbox/)
  })

  it.each([
    { platform: 'darwin', env: {} },
    { platform: 'linux', env: { CODEX_SANDBOX: 'seatbelt' } },
    { platform: 'win32', env: { CODEX_SANDBOX: 'seatbelt' } }
  ])('permits $platform outside the macOS seatbelt boundary', (options) => {
    expect(() => assertMacGuiLaunchAllowed(options)).not.toThrow()
  })

  it.skipIf(process.platform !== 'darwin')('exits the real dev entry before startup', () => {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('../development/launch/run-electron-vite-dev.mjs', import.meta.url))],
      {
        encoding: 'utf8',
        timeout: 10000,
        env: {
          ...process.env,
          CODEX_SANDBOX: 'seatbelt',
          ORCA_BACKGROUND_LAUNCH: '1',
          ORCA_ELECTRON_VITE_CLI: 'must-not-launch.mjs'
        }
      }
    )
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('outside the Codex sandbox')
    expect(result.stderr).not.toContain('must-not-launch')
    expect(result.stdout).not.toContain('Prepared wrapper')
  })
})
