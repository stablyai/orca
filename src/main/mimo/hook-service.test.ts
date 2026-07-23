import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { getPathMock } = vi.hoisted(() => ({
  getPathMock: vi.fn<(name: string) => string>()
}))

vi.mock('electron', () => ({
  app: {
    getPath: getPathMock
  }
}))

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

    mimocodeHome = mkdtempSync(join(tmpdir(), 'orca-mimocode-home-'))
    const configDir = join(mimocodeHome, 'config')
    mkdirSync(join(configDir, 'plugins'), { recursive: true })
    writeFileSync(join(configDir, 'mimocode.json'), '{"theme":"dark"}')
    writeFileSync(join(configDir, 'plugins', 'user-plugin.js'), 'export default () => {}')
    writeFileSync(join(configDir, 'plugins', 'orca-mimocode-status.js'), 'USER PLUGIN')
  })

  afterEach(() => {
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(mimocodeHome, { recursive: true, force: true })
  })

  it('mirrors user config into shared overlay and installs Orca status plugin', () => {
    const service = new MimoCodeHookService()
    const env = service.buildPtyEnv('pty-1', mimocodeHome)

    const overlayHome = join(userDataDir, 'mimocode-hooks', 'shared')
    expect(env.MIMOCODE_HOME).toBe(overlayHome)
    expect(readFileSync(join(overlayHome, 'config', 'mimocode.json'), 'utf8')).toBe(
      '{"theme":"dark"}'
    )
    expect(readFileSync(join(overlayHome, 'config', 'plugins', 'user-plugin.js'), 'utf8')).toBe(
      'export default () => {}'
    )

    const orcaPlugin = join(overlayHome, 'config', 'plugins', 'orca-mimocode-status.js')
    expect(existsSync(orcaPlugin)).toBe(true)
    expect(readFileSync(orcaPlugin, 'utf8')).toContain('/hook/mimo-code')

    expect(
      readFileSync(join(mimocodeHome, 'config', 'plugins', 'orca-mimocode-status.js'), 'utf8')
    ).toBe('USER PLUGIN')
  })

  it('reuses the overlay home on a second buildPtyEnv call', () => {
    const service = new MimoCodeHookService()
    const first = service.buildPtyEnv('pty-1', mimocodeHome)
    const second = service.buildPtyEnv('pty-2', mimocodeHome)

    const overlayHome = join(userDataDir, 'mimocode-hooks', 'shared')
    expect(first.MIMOCODE_HOME).toBe(overlayHome)
    expect(second.MIMOCODE_HOME).toBe(overlayHome)
    expect(
      readFileSync(join(overlayHome, 'config', 'plugins', 'orca-mimocode-status.js'), 'utf8')
    ).toContain('/hook/mimo-code')
  })

  it.skipIf(process.platform === 'win32')(
    'keeps a symlinked user plugins directory isolated from Orca writes',
    () => {
      const sourcePlugins = join(mimocodeHome, 'config', 'plugins')
      const realPlugins = join(mimocodeHome, 'real-plugins')
      rmSync(sourcePlugins, { recursive: true, force: true })
      mkdirSync(realPlugins)
      writeFileSync(join(realPlugins, 'user-plugin.js'), 'USER PLUGIN')
      symlinkSync(realPlugins, sourcePlugins, 'dir')

      const env = new MimoCodeHookService().buildPtyEnv('pty-1', mimocodeHome)
      const overlayPlugins = join(env.MIMOCODE_HOME!, 'config', 'plugins')

      expect(existsSync(join(realPlugins, 'orca-mimocode-status.js'))).toBe(false)
      expect(lstatSync(overlayPlugins).isSymbolicLink()).toBe(false)
      expect(readFileSync(join(overlayPlugins, 'user-plugin.js'), 'utf8')).toBe('USER PLUGIN')
      expect(readFileSync(join(overlayPlugins, 'orca-mimocode-status.js'), 'utf8')).toContain(
        '/hook/mimo-code'
      )
    }
  )

  it('falls back to the original home when the config plan exceeds capacity', async () => {
    const mirroring = await import('../pty/config-overlay-mirroring')
    const planSpy = vi.spyOn(mirroring, 'createConfigOverlayPlan').mockImplementation(() => {
      throw new mirroring.ConfigOverlayCapacityError('entries', 4_097, 4_096)
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(new MimoCodeHookService().buildPtyEnv('pty-1', mimocodeHome)).toEqual({
        MIMOCODE_HOME: mimocodeHome
      })
      expect(warnSpy).toHaveBeenCalledWith(
        '[mimocode-hooks] config overlay exceeded its memory limit; using the original MiMo home without Orca status integration'
      )
      expect(readFileSync(join(mimocodeHome, 'config', 'mimocode.json'), 'utf8')).toBe(
        '{"theme":"dark"}'
      )
    } finally {
      planSpy.mockRestore()
    }
  })
})
