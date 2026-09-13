import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'

const require = createRequire(import.meta.url)

describe('macOS signed launch gate publication boundary', () => {
  it.each(['release', 'hourly', 'daily', 'adhoc'])(
    '%s builds cannot materialize profiles and use the gated signing config',
    (channel) => {
      const source = readFileSync(
        new URL(`../../.github/workflows/${channel}-mac-build.yml`, import.meta.url),
        'utf8'
      )
      expect(source).not.toMatch(/MAC_PROVISIONING_PROFILE|provisionprofile/)
      const workflow = parse(source)
      const steps = Object.values(workflow.jobs).flatMap((job) => job.steps ?? [])
      const publishers = steps.filter((step) => step.with?.command?.includes('electron-builder'))
      expect(publishers).toHaveLength(1)
      const publisher = publishers[0]
      expect(publisher.with.command).toContain(
        `ORCA_BACKGROUND_LAUNCH=1 ORCA_MAC_${channel.toUpperCase()}=1`
      )
      expect(publisher.with.command).toContain(
        '--config config/electron-builder.config.cjs --mac --publish always'
      )
      expect(publisher.with.command).not.toContain('--prepackaged')
      expect(steps.findIndex((step) => step.run === 'pnpm build:release')).toBeLessThan(
        steps.indexOf(publisher)
      )
    }
  )

  it('awaits the signed-app gate from afterSign with no environment bypass', () => {
    const config = require('../electron-builder.config.cjs')
    const hook = config.afterSign.toString()
    expect(hook).toContain('isMacRelease')
    expect(hook).toContain("context.electronPlatformName === 'darwin'")
    expect(hook).toContain("import('./scripts/verify-macos-signed-app.mjs')")
    expect(hook).toContain('await verifyMacSignedApp(context)')
    expect(hook).not.toContain('process.env')
  })

  it('the installed packager stops before distributable creation when signed packing rejects', async () => {
    const { MacPackager } = require('app-builder-lib')
    const createArtifacts = vi.fn()
    const packager = {
      appInfo: { productFilename: 'Orca' },
      computeAppOutDir: () => '/signed',
      getPlatformConfig: () => ({ platformName: 'darwin', config: {} }),
      doPack: vi.fn(async () => {
        throw new Error('launch gate rejected')
      }),
      packageInDistributableFormat: createArtifacts
    }
    await expect(
      MacPackager.prototype.packMacTargets.call(packager, '/out', 3, [], null, {})
    ).rejects.toThrow('launch gate rejected')
    expect(createArtifacts).not.toHaveBeenCalled()
  })
})
