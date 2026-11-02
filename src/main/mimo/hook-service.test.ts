import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setAppEnvironment } from '../../shared/app-environment'

const { getPathMock } = vi.hoisted(() => ({
  getPathMock: vi.fn<(name: string) => string>()
}))

import { MimoCodeHookService } from './hook-service'

describe('MimoCodeHookService buildPtyEnv', () => {
  let userDataDir: string
  let userConfigDir: string

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

    userConfigDir = mkdtempSync(join(tmpdir(), 'orca-mimocode-config-'))
    mkdirSync(join(userConfigDir, 'plugins'), { recursive: true })
    writeFileSync(join(userConfigDir, 'mimocode.json'), '{"theme":"dark"}')
    writeFileSync(join(userConfigDir, 'plugins', 'user-plugin.js'), 'export default () => {}')
    writeFileSync(join(userConfigDir, 'plugins', 'orca-mimocode-status.js'), 'USER PLUGIN')
  })

  afterEach(() => {
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(userConfigDir, { recursive: true, force: true })
  })

  // MIMOCODE_HOME also moves auth.json, sessions and state (#9132); only add a config layer.
  it('sets only MIMOCODE_CONFIG_DIR to a directory holding just the Orca plugin', () => {
    const env = new MimoCodeHookService().buildPtyEnv('pty-1')

    const overlay = join(userDataDir, 'mimocode-hooks', 'config')
    expect(env).toEqual({ MIMOCODE_CONFIG_DIR: overlay })
    expect(readdirSync(overlay)).toEqual(['plugins'])
    const pluginSource = readFileSync(join(overlay, 'plugins', 'orca-mimocode-status.js'), 'utf8')
    expect(pluginSource).toContain('/hook/mimo-code')
    expect(pluginSource).not.toContain('post("SessionStart"')
  })

  it("layers the user's own MIMOCODE_CONFIG_DIR into the overlay without touching it", () => {
    const env = new MimoCodeHookService().buildPtyEnv('pty-1', userConfigDir)

    const overlay = env.MIMOCODE_CONFIG_DIR ?? ''
    expect(overlay).toContain(join(userDataDir, 'mimocode-hooks', 'config-overlays'))
    expect(readFileSync(join(overlay, 'mimocode.json'), 'utf8')).toBe('{"theme":"dark"}')
    expect(readFileSync(join(overlay, 'plugins', 'user-plugin.js'), 'utf8')).toBe(
      'export default () => {}'
    )
    expect(readFileSync(join(overlay, 'plugins', 'orca-mimocode-status.js'), 'utf8')).toContain(
      '/hook/mimo-code'
    )
    expect(readFileSync(join(userConfigDir, 'plugins', 'orca-mimocode-status.js'), 'utf8')).toBe(
      'USER PLUGIN'
    )
  })

  it.skipIf(process.platform === 'win32')(
    "never writes the Orca plugin through a user's linked plugins folder",
    () => {
      const linkedPlugins = mkdtempSync(join(tmpdir(), 'orca-mimocode-linked-plugins-'))
      writeFileSync(join(linkedPlugins, 'user-plugin.js'), 'export default () => {}')
      rmSync(join(userConfigDir, 'plugins'), { recursive: true })
      symlinkSync(linkedPlugins, join(userConfigDir, 'plugins'))
      try {
        const env = new MimoCodeHookService().buildPtyEnv('pty-1', userConfigDir)

        expect(existsSync(join(env.MIMOCODE_CONFIG_DIR ?? '', 'plugins', 'user-plugin.js'))).toBe(
          true
        )
        expect(readdirSync(linkedPlugins)).toEqual(['user-plugin.js'])
      } finally {
        rmSync(linkedPlugins, { recursive: true, force: true })
      }
    }
  )

  it('carries a login made under the old Orca MIMOCODE_HOME over once, owner-only', () => {
    const legacyData = join(userDataDir, 'mimocode-hooks', 'shared', 'data')
    mkdirSync(legacyData, { recursive: true })
    writeFileSync(join(legacyData, 'auth.json'), '{"legacy":true}')
    const xdgData = join(userDataDir, 'xdg-data')
    const service = new MimoCodeHookService()

    service.carryOverLegacyAuth({ XDG_DATA_HOME: xdgData })
    const auth = join(xdgData, 'mimocode', 'auth.json')
    expect(readFileSync(auth, 'utf8')).toBe('{"legacy":true}')
    if (process.platform !== 'win32') {
      expect(statSync(auth).mode & 0o777).toBe(0o600)
    }

    expect(existsSync(join(legacyData, 'auth.json'))).toBe(false)
    expect(existsSync(join(legacyData, 'auth.json.migrated'))).toBe(true)

    rmSync(auth)
    service.carryOverLegacyAuth({ XDG_DATA_HOME: xdgData })
    expect(existsSync(auth)).toBe(false)
  })

  it('never overwrites an existing login or follows a relative MIMOCODE_HOME', () => {
    const legacyData = join(userDataDir, 'mimocode-hooks', 'shared', 'data')
    mkdirSync(legacyData, { recursive: true })
    writeFileSync(join(legacyData, 'auth.json'), '{"legacy":true}')
    const xdgData = join(userDataDir, 'xdg-data')
    mkdirSync(join(xdgData, 'mimocode'), { recursive: true })
    const auth = join(xdgData, 'mimocode', 'auth.json')
    writeFileSync(auth, '{"canonical":true}')
    const service = new MimoCodeHookService()

    service.carryOverLegacyAuth({ MIMOCODE_HOME: 'relative-mimo-home' })
    expect(existsSync(join(process.cwd(), 'relative-mimo-home'))).toBe(false)
    expect(existsSync(join(legacyData, 'auth.json'))).toBe(true)

    service.carryOverLegacyAuth({ XDG_DATA_HOME: xdgData })
    expect(readFileSync(auth, 'utf8')).toBe('{"canonical":true}')
    expect(existsSync(join(legacyData, 'auth.json.migrated'))).toBe(true)

    rmSync(auth)
    service.carryOverLegacyAuth({ XDG_DATA_HOME: xdgData })
    expect(existsSync(auth)).toBe(false)
  })
})
