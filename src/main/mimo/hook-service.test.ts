import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setAppEnvironment } from '../../shared/app-environment'

const { getPathMock } = vi.hoisted(() => ({ getPathMock: vi.fn<(name: string) => string>() }))

import { MimoCodeHookService } from './hook-service'

describe('MimoCodeHookService buildPtyEnv', () => {
  let userDataDir: string
  let mimocodeHome: string

  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'orca-mimocode-userdata-'))
    getPathMock.mockImplementation((name) => {
      if (name === 'userData') {
        return userDataDir
      }
      throw new Error(`unexpected getPath: ${name}`)
    })
    setAppEnvironment({
      getPath: getPathMock,
      getAppPath: () => process.cwd(),
      getVersion: () => '0.0.0-test',
      isPackaged: () => false,
      onWillQuit: () => {},
      exit: () => {},
      getAppMetrics: () => []
    })

    mimocodeHome = mkdtempSync(join(tmpdir(), 'orca-mimocode-home-'))
    const configDir = join(mimocodeHome, 'config')
    mkdirSync(join(configDir, 'plugins'), { recursive: true })
    writeFileSync(join(configDir, 'mimocode.json'), '{"theme":"dark"}')
    writeFileSync(join(configDir, 'plugins', 'user-plugin.js'), 'export default () => {}')
    writeFileSync(join(configDir, 'plugins', 'orca-mimocode-status.js'), 'USER PLUGIN')
    mkdirSync(join(mimocodeHome, 'data'), { recursive: true })
    writeFileSync(join(mimocodeHome, 'data', 'mimocode.db'), 'session:e2e-mimo-session')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(mimocodeHome, { recursive: true, force: true })
  })

  it('mirrors user config into a source overlay and installs Orca status plugin', () => {
    const service = new MimoCodeHookService()
    const env = service.buildPtyEnv('pty-1', mimocodeHome)

    const overlayHome = env.MIMOCODE_HOME
    expect(overlayHome).toMatch(
      new RegExp(
        `${join(userDataDir, 'mimocode-hooks', 'source-').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[a-f0-9]{16}$`
      )
    )
    expect(readFileSync(join(overlayHome, 'config', 'mimocode.json'), 'utf8')).toBe(
      '{"theme":"dark"}'
    )
    expect(readFileSync(join(overlayHome, 'config', 'plugins', 'user-plugin.js'), 'utf8')).toBe(
      'export default () => {}'
    )

    const orcaPlugin = join(overlayHome, 'config', 'plugins', 'orca-mimocode-status.js')
    expect(existsSync(orcaPlugin)).toBe(true)
    const pluginSource = readFileSync(orcaPlugin, 'utf8')
    expect(pluginSource).toContain('/hook/mimo-code')
    expect(pluginSource).not.toContain('post("SessionStart"')

    expect(
      readFileSync(join(mimocodeHome, 'config', 'plugins', 'orca-mimocode-status.js'), 'utf8')
    ).toBe('USER PLUGIN')
  })

  it('reuses the overlay home on a second buildPtyEnv call', () => {
    const service = new MimoCodeHookService()
    const first = service.buildPtyEnv('pty-1', mimocodeHome)
    const second = service.buildPtyEnv('pty-2', mimocodeHome)

    const overlayHome = first.MIMOCODE_HOME
    expect(second.MIMOCODE_HOME).toBe(overlayHome)
    expect(
      readFileSync(join(overlayHome, 'config', 'plugins', 'orca-mimocode-status.js'), 'utf8')
    ).toContain('/hook/mimo-code')
  })

  it('keeps concurrent panes on different MiMo sources isolated', () => {
    const secondMimocodeHome = mkdtempSync(join(tmpdir(), 'orca-mimocode-home-'))
    mkdirSync(join(secondMimocodeHome, 'data'), { recursive: true })
    writeFileSync(join(secondMimocodeHome, 'data', 'mimocode.db'), 'session:second-source')

    try {
      const service = new MimoCodeHookService()
      const first = service.buildPtyEnv('pty-1', mimocodeHome)
      const second = service.buildPtyEnv('pty-2', secondMimocodeHome)

      expect(first.MIMOCODE_HOME).not.toBe(second.MIMOCODE_HOME)
      expect(readFileSync(join(first.MIMOCODE_HOME, 'data', 'mimocode.db'), 'utf8')).toBe(
        'session:e2e-mimo-session'
      )
      expect(readFileSync(join(second.MIMOCODE_HOME, 'data', 'mimocode.db'), 'utf8')).toBe(
        'session:second-source'
      )
    } finally {
      rmSync(secondMimocodeHome, { recursive: true, force: true })
    }
  })

  it('keeps existing MiMo session data visible through the overlay home', () => {
    const service = new MimoCodeHookService()
    const env = service.buildPtyEnv('pty-session-resume', mimocodeHome)

    expect(readFileSync(join(env.MIMOCODE_HOME, 'data', 'mimocode.db'), 'utf8')).toBe(
      'session:e2e-mimo-session'
    )
  })

  it('keeps session data from the default XDG data directory visible', () => {
    const xdgDataHome = join(mimocodeHome, 'xdg-data')
    const sourceDataDir = join(xdgDataHome, 'mimocode')
    mkdirSync(sourceDataDir, { recursive: true })
    writeFileSync(join(sourceDataDir, 'mimocode.db'), 'session:xdg-mimo-session')
    vi.stubEnv('XDG_DATA_HOME', join(mimocodeHome, 'process-xdg-data'))

    const service = new MimoCodeHookService()
    const env = service.buildPtyEnv('pty-xdg-session-resume', undefined, {
      HOME: mimocodeHome,
      XDG_DATA_HOME: xdgDataHome
    })

    expect(readFileSync(join(env.MIMOCODE_HOME, 'data', 'mimocode.db'), 'utf8')).toBe(
      'session:xdg-mimo-session'
    )
  })
})
