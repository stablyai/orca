import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PluginOverlayManager } from './plugin-overlay'
import { resolveOmpConfigDirName, resolvePiSourceAgentDir } from './plugin-overlay-env'
import { __resetShellStartupEnvCache } from '../main/pty/shell-startup-env'
import { resetLoginShellEnvironmentCacheForTests } from '../main/startup/login-shell-environment'

describe('relay OMP config root', () => {
  let home: string
  let manager: PluginOverlayManager

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'orca-relay-omp-config-'))
    manager = new PluginOverlayManager({ homeDir: home })
    manager.setSources({ ompExtensionSource: 'export default function() {}' })
    __resetShellStartupEnvCache()
    resetLoginShellEnvironmentCacheForTests()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    __resetShellStartupEnvCache()
    resetLoginShellEnvironmentCacheForTests()
    rmSync(home, { recursive: true, force: true })
  })

  it.each(['.company-omp', '.config/omp', ''])(
    'installs into the guest config root %j',
    async (config) => {
      const env = { HOME: home, PI_CONFIG_DIR: config }
      const result = manager.materializePi(
        'pane',
        resolvePiSourceAgentDir(env, '/bin/bash', 'omp'),
        'omp',
        {
          materializeDefaultHome: true,
          configDirName: await resolveOmpConfigDirName(env, '/bin/bash')
        }
      )
      const expected = join(home, config || '.omp', 'agent')
      expect(result?.sourceAgentDir).toBe(expected)
      expect(readFileSync(join(expected, 'extensions', 'orca-agent-status.ts'), 'utf8')).toContain(
        '@orca-managed-pi-extension'
      )
      if (config) {
        expect(existsSync(join(home, '.omp'))).toBe(false)
      }
    }
  )

  it('keeps an explicit source directory ahead of the config root', () => {
    const source = join(home, 'explicit-agent')
    mkdirSync(source)
    const result = manager.materializePi('pane', source, 'omp', { configDirName: '.company-omp' })
    expect(result?.sourceAgentDir).toBe(source)
    expect(existsSync(join(home, '.company-omp'))).toBe(false)
  })

  it('does not create a missing config root for a bare shell', () => {
    const result = manager.materializePi('pane', undefined, 'omp', {
      materializeDefaultHome: false,
      configDirName: '.company-omp'
    })
    expect(result?.sourceAgentDir).toBeUndefined()
    expect(result?.statusExtensionPath).toBeTruthy()
    expect(existsSync(join(home, '.company-omp'))).toBe(false)
  })

  it('does not fall back to process.env for the config root', async () => {
    vi.stubEnv('PI_CONFIG_DIR', '.wrong-process-root')
    expect(await resolveOmpConfigDirName({ HOME: home }, '/bin/bash')).toBeUndefined()
  })

  it.skipIf(process.platform === 'win32')(
    'uses the guest profile only when no pane override exists',
    async () => {
      writeFileSync(join(home, '.bash_profile'), 'export PI_CONFIG_DIR=".profile-omp"\n')
      expect(await resolveOmpConfigDirName({ HOME: home }, '/bin/bash')).toBe('.profile-omp')
      expect(await resolveOmpConfigDirName({ HOME: home, PI_CONFIG_DIR: '' }, '/bin/bash')).toBe(
        '.omp'
      )
      expect(
        await resolveOmpConfigDirName({ HOME: home, PI_CONFIG_DIR: '.pane-omp' }, '/bin/bash')
      ).toBe('.pane-omp')
    }
  )
})
