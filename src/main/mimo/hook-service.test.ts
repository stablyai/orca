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
})
