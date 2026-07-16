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
  let sourceConfigDir: string

  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'orca-mimocode-userdata-'))
    getPathMock.mockImplementation((name) => {
      if (name === 'userData') {
        return userDataDir
      }
      throw new Error(`unexpected getPath: ${name}`)
    })

    sourceConfigDir = mkdtempSync(join(tmpdir(), 'orca-mimocode-config-'))
    mkdirSync(join(sourceConfigDir, 'plugins'), { recursive: true })
    for (const entry of ['data', 'cache', 'state']) {
      mkdirSync(join(sourceConfigDir, entry), { recursive: true })
      writeFileSync(join(sourceConfigDir, entry, 'sentinel'), 'USER DATA')
    }
    writeFileSync(join(sourceConfigDir, 'mimocode.json'), '{"theme":"dark"}')
    writeFileSync(join(sourceConfigDir, 'auth.json'), 'USER AUTH')
    writeFileSync(join(sourceConfigDir, 'plugins', 'user-plugin.js'), 'export default () => {}')
    writeFileSync(join(sourceConfigDir, 'plugins', 'orca-mimocode-status.js'), 'USER PLUGIN')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(sourceConfigDir, { recursive: true, force: true })
  })

  it('creates a config-only overlay and preserves MiMo data ownership', () => {
    const service = new MimoCodeHookService()
    const env = service.buildPtyEnv('pty-1', sourceConfigDir)

    const overlayConfig = join(userDataDir, 'mimocode-config-overlays', 'shared')
    expect(env).toEqual({ MIMOCODE_CONFIG_DIR: overlayConfig })
    for (const entry of ['data', 'cache', 'state', 'auth.json']) {
      expect(existsSync(join(overlayConfig, entry))).toBe(false)
    }
    expect(readFileSync(join(overlayConfig, 'mimocode.json'), 'utf8')).toBe('{"theme":"dark"}')
    expect(readFileSync(join(overlayConfig, 'plugins', 'user-plugin.js'), 'utf8')).toBe(
      'export default () => {}'
    )

    const orcaPlugin = join(overlayConfig, 'plugins', 'orca-mimocode-status.js')
    expect(readFileSync(orcaPlugin, 'utf8')).toContain('/hook/mimo-code')
    expect(readFileSync(join(sourceConfigDir, 'auth.json'), 'utf8')).toBe('USER AUTH')
    expect(readFileSync(join(sourceConfigDir, 'plugins', 'orca-mimocode-status.js'), 'utf8')).toBe(
      'USER PLUGIN'
    )
  })

  it('creates a plugin-only overlay when the source config does not exist', () => {
    const missingConfigDir = join(sourceConfigDir, 'missing')
    const service = new MimoCodeHookService()
    const env = service.buildPtyEnv('pty-1', missingConfigDir)

    const overlayConfig = join(userDataDir, 'mimocode-config-overlays', 'shared')
    expect(env).toEqual({ MIMOCODE_CONFIG_DIR: overlayConfig })
    expect(
      readFileSync(join(overlayConfig, 'plugins', 'orca-mimocode-status.js'), 'utf8')
    ).toContain('/hook/mimo-code')
    expect(existsSync(join(overlayConfig, 'mimocode.json'))).toBe(false)
  })

  it('falls back to the existing config dir when mirroring fails', async () => {
    const overlayMirror = await import('../pty/overlay-mirror')
    vi.spyOn(overlayMirror, 'mirrorEntry').mockImplementation(() => {
      throw new Error('simulated mirror failure')
    })

    const service = new MimoCodeHookService()
    expect(service.buildPtyEnv('pty-1', sourceConfigDir)).toEqual({
      MIMOCODE_CONFIG_DIR: sourceConfigDir
    })
  })

  it('falls back to the existing config dir when writing the overlay fails', () => {
    const blockedUserData = join(userDataDir, 'not-a-directory')
    writeFileSync(blockedUserData, '')
    getPathMock.mockReturnValue(blockedUserData)

    const service = new MimoCodeHookService()
    expect(service.buildPtyEnv('pty-1', sourceConfigDir)).toEqual({
      MIMOCODE_CONFIG_DIR: sourceConfigDir
    })
  })

  it('returns no override when writing fails without an existing config dir', () => {
    const blockedUserData = join(userDataDir, 'not-a-directory')
    writeFileSync(blockedUserData, '')
    getPathMock.mockReturnValue(blockedUserData)

    const service = new MimoCodeHookService()
    expect(service.buildPtyEnv('pty-1')).toEqual({})
  })

  it('cleans the previous overlay before rebuilding it', () => {
    const service = new MimoCodeHookService()
    const firstEnv = service.buildPtyEnv('pty-1', sourceConfigDir)
    const overlayConfig = firstEnv.MIMOCODE_CONFIG_DIR!

    rmSync(join(sourceConfigDir, 'mimocode.json'))
    rmSync(join(sourceConfigDir, 'plugins', 'user-plugin.js'))
    writeFileSync(join(sourceConfigDir, 'new-config.json'), '{}')

    const secondEnv = service.buildPtyEnv('pty-2', sourceConfigDir)

    expect(secondEnv.MIMOCODE_CONFIG_DIR).toBe(overlayConfig)
    expect(existsSync(join(overlayConfig, 'mimocode.json'))).toBe(false)
    expect(existsSync(join(overlayConfig, 'plugins', 'user-plugin.js'))).toBe(false)
    expect(readFileSync(join(overlayConfig, 'new-config.json'), 'utf8')).toBe('{}')
    expect(
      readFileSync(join(overlayConfig, 'plugins', 'orca-mimocode-status.js'), 'utf8')
    ).toContain('/hook/mimo-code')
  })

  it('does not clean or modify the source when it is the overlay path', () => {
    const overlayConfig = join(userDataDir, 'mimocode-config-overlays', 'shared')
    mkdirSync(join(overlayConfig, 'plugins'), { recursive: true })
    writeFileSync(join(overlayConfig, 'mimocode.json'), 'SOURCE CONFIG')
    writeFileSync(join(overlayConfig, 'plugins', 'orca-mimocode-status.js'), 'SOURCE PLUGIN')

    const service = new MimoCodeHookService()
    expect(service.buildPtyEnv('pty-1', overlayConfig)).toEqual({
      MIMOCODE_CONFIG_DIR: overlayConfig
    })
    expect(readFileSync(join(overlayConfig, 'mimocode.json'), 'utf8')).toBe('SOURCE CONFIG')
    expect(readFileSync(join(overlayConfig, 'plugins', 'orca-mimocode-status.js'), 'utf8')).toBe(
      'SOURCE PLUGIN'
    )
  })

  it('does not clean a source that aliases the overlay path', () => {
    const overlayConfig = join(userDataDir, 'mimocode-config-overlays', 'shared')
    const sourceAlias = join(userDataDir, 'config-alias')
    mkdirSync(overlayConfig, { recursive: true })
    writeFileSync(join(overlayConfig, 'mimocode.json'), 'SOURCE CONFIG')
    symlinkSync(overlayConfig, sourceAlias, process.platform === 'win32' ? 'junction' : 'dir')

    const service = new MimoCodeHookService()
    expect(service.buildPtyEnv('pty-1', sourceAlias)).toEqual({
      MIMOCODE_CONFIG_DIR: sourceAlias
    })
    expect(readFileSync(join(overlayConfig, 'mimocode.json'), 'utf8')).toBe('SOURCE CONFIG')
  })

  it('keeps overlay plugins real when source plugins is a symlink to a directory', () => {
    const realPluginsDir = mkdtempSync(join(tmpdir(), 'orca-mimocode-plugins-'))
    rmSync(join(sourceConfigDir, 'plugins'), { recursive: true })
    writeFileSync(join(realPluginsDir, 'user-plugin.js'), 'USER PLUGIN')
    writeFileSync(join(realPluginsDir, 'orca-mimocode-status.js'), 'SOURCE PLUGIN')
    symlinkSync(
      realPluginsDir,
      join(sourceConfigDir, 'plugins'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )

    try {
      const service = new MimoCodeHookService()
      const env = service.buildPtyEnv('pty-1', sourceConfigDir)
      const overlayPlugins = join(env.MIMOCODE_CONFIG_DIR!, 'plugins')

      expect(lstatSync(overlayPlugins).isSymbolicLink()).toBe(false)
      expect(readFileSync(join(overlayPlugins, 'user-plugin.js'), 'utf8')).toBe('USER PLUGIN')
      expect(readFileSync(join(realPluginsDir, 'orca-mimocode-status.js'), 'utf8')).toBe(
        'SOURCE PLUGIN'
      )
      expect(readFileSync(join(overlayPlugins, 'orca-mimocode-status.js'), 'utf8')).toContain(
        '/hook/mimo-code'
      )
    } finally {
      rmSync(realPluginsDir, { recursive: true, force: true })
    }
  })

  it('falls back before rebuilding when cleanup leaves a non-empty config directory', async () => {
    const overlayMirror = await import('../pty/overlay-mirror')
    vi.spyOn(overlayMirror, 'safeRemoveTree').mockImplementation(() => {})
    const overlayConfig = join(userDataDir, 'mimocode-config-overlays', 'shared')
    const residualConfig = join(overlayConfig, 'residual.json')
    mkdirSync(overlayConfig, { recursive: true })
    writeFileSync(residualConfig, 'RESIDUAL CONFIG')

    const service = new MimoCodeHookService()
    expect(service.buildPtyEnv('pty-1', sourceConfigDir)).toEqual({
      MIMOCODE_CONFIG_DIR: sourceConfigDir
    })
    expect(readFileSync(residualConfig, 'utf8')).toBe('RESIDUAL CONFIG')
    expect(existsSync(join(overlayConfig, 'plugins'))).toBe(false)
  })

  it('falls back before writing when cleanup leaves a plugins symlink', async () => {
    const overlayMirror = await import('../pty/overlay-mirror')
    vi.spyOn(overlayMirror, 'safeRemoveTree').mockImplementation(() => {})
    const overlayConfig = join(userDataDir, 'mimocode-config-overlays', 'shared')
    const linkedPluginsDir = mkdtempSync(join(tmpdir(), 'orca-mimocode-linked-plugins-'))
    mkdirSync(overlayConfig, { recursive: true })
    symlinkSync(
      linkedPluginsDir,
      join(overlayConfig, 'plugins'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    writeFileSync(join(linkedPluginsDir, 'orca-mimocode-status.js'), 'SOURCE PLUGIN')

    try {
      const service = new MimoCodeHookService()
      expect(service.buildPtyEnv('pty-1', sourceConfigDir)).toEqual({
        MIMOCODE_CONFIG_DIR: sourceConfigDir
      })
      expect(existsSync(join(linkedPluginsDir, 'user-plugin.js'))).toBe(false)
      expect(readFileSync(join(linkedPluginsDir, 'orca-mimocode-status.js'), 'utf8')).toBe(
        'SOURCE PLUGIN'
      )
    } finally {
      rmSync(linkedPluginsDir, { recursive: true, force: true })
    }
  })
})
