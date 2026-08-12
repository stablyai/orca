import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

import { KiloHookService } from './hook-service'

describe('KiloHookService buildPtyEnv', () => {
  let userDataDir: string
  let kiloConfigDir: string

  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'orca-kilo-userdata-'))
    getPathMock.mockImplementation((name) => {
      if (name === 'userData') {
        return userDataDir
      }
      throw new Error(`unexpected getPath: ${name}`)
    })

    kiloConfigDir = mkdtempSync(join(tmpdir(), 'orca-kilo-config-'))
    mkdirSync(join(kiloConfigDir, 'plugins'), { recursive: true })
    writeFileSync(join(kiloConfigDir, 'kilo.json'), '{"theme":"dark"}')
    writeFileSync(join(kiloConfigDir, 'plugins', 'user-plugin.js'), 'export default () => {}')
    writeFileSync(join(kiloConfigDir, 'plugins', 'orca-kilo-status.js'), 'USER PLUGIN')
  })

  afterEach(() => {
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(kiloConfigDir, { recursive: true, force: true })
  })

  it('mirrors user config into shared overlay and installs Orca status plugin', () => {
    const service = new KiloHookService()
    const env = service.buildPtyEnv('pty-1', kiloConfigDir)

    const overlayConfig = join(userDataDir, 'kilo-hooks', 'shared')
    expect(env.KILO_CONFIG_DIR).toBe(overlayConfig)
    expect(readFileSync(join(overlayConfig, 'kilo.json'), 'utf8')).toBe('{"theme":"dark"}')
    expect(readFileSync(join(overlayConfig, 'plugins', 'user-plugin.js'), 'utf8')).toBe(
      'export default () => {}'
    )

    const orcaPlugin = join(overlayConfig, 'plugins', 'orca-kilo-status.js')
    expect(existsSync(orcaPlugin)).toBe(true)
    expect(readFileSync(orcaPlugin, 'utf8')).toContain('/hook/kilo')

    expect(readFileSync(join(kiloConfigDir, 'plugins', 'orca-kilo-status.js'), 'utf8')).toBe(
      'USER PLUGIN'
    )
  })

  it('reuses the overlay config on a second buildPtyEnv call', () => {
    const service = new KiloHookService()
    const first = service.buildPtyEnv('pty-1', kiloConfigDir)
    const second = service.buildPtyEnv('pty-2', kiloConfigDir)

    const overlayConfig = join(userDataDir, 'kilo-hooks', 'shared')
    expect(first.KILO_CONFIG_DIR).toBe(overlayConfig)
    expect(second.KILO_CONFIG_DIR).toBe(overlayConfig)
    expect(
      readFileSync(join(overlayConfig, 'plugins', 'orca-kilo-status.js'), 'utf8')
    ).toContain('/hook/kilo')
  })

  it('still installs the status plugin when no user config dir exists', () => {
    const service = new KiloHookService()
    const env = service.buildPtyEnv('pty-1')

    const overlayConfig = join(userDataDir, 'kilo-hooks', 'shared')
    expect(env.KILO_CONFIG_DIR).toBe(overlayConfig)
    expect(
      readFileSync(join(overlayConfig, 'plugins', 'orca-kilo-status.js'), 'utf8')
    ).toContain('/hook/kilo')
  })
})
