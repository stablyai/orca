import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const { getPathMock } = vi.hoisted(() => ({
  getPathMock: vi.fn<(name: string) => string>()
}))

vi.mock('electron', () => ({
  app: {
    getPath: getPathMock
  }
}))

import { MimoCodeHookService } from './hook-service'

function overlayConfigDir(userDataDir: string, ptyId: string): string {
  return join(
    userDataDir,
    'mimocode-config-overlays',
    createHash('sha256').update(ptyId).digest('hex')
  )
}

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
    for (const entry of ['data', 'cache', 'state', 'session', 'sessions', 'memory', 'storage']) {
      mkdirSync(join(sourceConfigDir, entry), { recursive: true })
      writeFileSync(join(sourceConfigDir, entry, 'sentinel'), 'USER DATA')
    }
    mkdirSync(join(sourceConfigDir, 'node_modules', 'example', 'data'), { recursive: true })
    writeFileSync(
      join(sourceConfigDir, 'node_modules', 'example', 'data', 'sentinel'),
      'PACKAGE DATA'
    )
    writeFileSync(join(sourceConfigDir, 'mimocode.json'), '{"theme":"dark"}')
    writeFileSync(join(sourceConfigDir, 'auth.json'), 'USER AUTH')
    for (const entry of [
      'mimocode.sqlite',
      'mimocode.sqlite-wal',
      'mimocode.sqlite-shm',
      'mimocode.sqlite-journal',
      'STATE.SQLITE-JOURNAL'
    ]) {
      writeFileSync(join(sourceConfigDir, entry), 'USER DATABASE')
    }
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

    const overlayConfig = env.MIMOCODE_CONFIG_DIR!
    expect(env).toEqual({ MIMOCODE_CONFIG_DIR: overlayConfig })
    expect(overlayConfig).toContain(join(userDataDir, 'mimocode-config-overlays'))
    for (const entry of [
      'data',
      'cache',
      'state',
      'session',
      'sessions',
      'memory',
      'storage',
      'auth.json',
      'mimocode.sqlite',
      'mimocode.sqlite-wal',
      'mimocode.sqlite-shm',
      'mimocode.sqlite-journal',
      'STATE.SQLITE-JOURNAL'
    ]) {
      expect(existsSync(join(overlayConfig, entry))).toBe(false)
    }
    expect(existsSync(join(overlayConfig, 'node_modules', 'example', 'data', 'sentinel'))).toBe(
      true
    )
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

    const overlayConfig = env.MIMOCODE_CONFIG_DIR!
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

  it('reuses a safe overlay for the same PTY and source without cleanup', async () => {
    const overlayMirror = await import('../pty/overlay-mirror')
    const safeRemoveSpy = vi.spyOn(overlayMirror, 'safeRemoveTree')
    const service = new MimoCodeHookService()
    const firstEnv = service.buildPtyEnv('pty-1', sourceConfigDir)
    const overlayConfig = firstEnv.MIMOCODE_CONFIG_DIR!
    safeRemoveSpy.mockClear()

    const secondEnv = service.buildPtyEnv('pty-1', sourceConfigDir)

    expect(secondEnv).toEqual(firstEnv)
    expect(safeRemoveSpy).not.toHaveBeenCalled()
    expect(readFileSync(join(overlayConfig, 'mimocode.json'), 'utf8')).toBe('{"theme":"dark"}')
  })

  it('reuses an owned PTY overlay when the source changes until the PTY is cleared', async () => {
    const overlayMirror = await import('../pty/overlay-mirror')
    const safeRemoveSpy = vi.spyOn(overlayMirror, 'safeRemoveTree')
    const secondSourceConfigDir = mkdtempSync(join(tmpdir(), 'orca-mimocode-config-second-'))
    writeFileSync(join(secondSourceConfigDir, 'mimocode.json'), 'SECOND CONFIG')

    try {
      const service = new MimoCodeHookService()
      const firstEnv = service.buildPtyEnv('pty-1', sourceConfigDir)
      safeRemoveSpy.mockClear()

      expect(service.buildPtyEnv('pty-1', secondSourceConfigDir)).toEqual(firstEnv)
      expect(safeRemoveSpy).not.toHaveBeenCalled()
      expect(readFileSync(join(firstEnv.MIMOCODE_CONFIG_DIR!, 'mimocode.json'), 'utf8')).toBe(
        '{"theme":"dark"}'
      )

      service.clearPty('pty-1')
      const rebuiltEnv = service.buildPtyEnv('pty-1', secondSourceConfigDir)
      expect(rebuiltEnv.MIMOCODE_CONFIG_DIR).toBe(firstEnv.MIMOCODE_CONFIG_DIR)
      expect(readFileSync(join(rebuiltEnv.MIMOCODE_CONFIG_DIR!, 'mimocode.json'), 'utf8')).toBe(
        'SECOND CONFIG'
      )
    } finally {
      rmSync(secondSourceConfigDir, { recursive: true, force: true })
    }
  })

  it('isolates overlays for two PTYs with different config sources', () => {
    const secondSourceConfigDir = mkdtempSync(join(tmpdir(), 'orca-mimocode-config-second-'))
    writeFileSync(join(secondSourceConfigDir, 'mimocode.json'), 'SECOND CONFIG')

    try {
      const service = new MimoCodeHookService()
      const firstEnv = service.buildPtyEnv('pty-1', sourceConfigDir)
      const secondEnv = service.buildPtyEnv('pty-2', secondSourceConfigDir)

      expect(firstEnv.MIMOCODE_CONFIG_DIR).not.toBe(secondEnv.MIMOCODE_CONFIG_DIR)
      expect(readFileSync(join(firstEnv.MIMOCODE_CONFIG_DIR!, 'mimocode.json'), 'utf8')).toBe(
        '{"theme":"dark"}'
      )
      expect(readFileSync(join(secondEnv.MIMOCODE_CONFIG_DIR!, 'mimocode.json'), 'utf8')).toBe(
        'SECOND CONFIG'
      )
    } finally {
      rmSync(secondSourceConfigDir, { recursive: true, force: true })
    }
  })

  it('removes only the cleared PTY overlay', () => {
    const service = new MimoCodeHookService()
    const firstEnv = service.buildPtyEnv('pty-1', sourceConfigDir)
    const secondEnv = service.buildPtyEnv('pty-2', sourceConfigDir)

    service.clearPty('pty-1')

    expect(existsSync(firstEnv.MIMOCODE_CONFIG_DIR!)).toBe(false)
    expect(existsSync(secondEnv.MIMOCODE_CONFIG_DIR!)).toBe(true)
  })

  it('drops ownership without reusing or clearing through a replaced overlay root', () => {
    const externalDir = mkdtempSync(join(tmpdir(), 'orca-mimocode-external-'))
    const movedOverlayRoot = join(userDataDir, 'moved-overlay-root')
    const overlayRoot = join(userDataDir, 'mimocode-config-overlays')
    const externalSentinels = ['pty-1', 'pty-2'].map((ptyId) => {
      const externalTarget = join(externalDir, createHash('sha256').update(ptyId).digest('hex'))
      const sentinel = join(externalTarget, 'sentinel')
      mkdirSync(externalTarget)
      writeFileSync(sentinel, 'EXTERNAL')
      return sentinel
    })

    try {
      const service = new MimoCodeHookService()
      service.buildPtyEnv('pty-1', sourceConfigDir)
      service.buildPtyEnv('pty-2', sourceConfigDir)
      renameSync(overlayRoot, movedOverlayRoot)
      symlinkSync(externalDir, overlayRoot, process.platform === 'win32' ? 'junction' : 'dir')

      expect(service.buildPtyEnv('pty-1', sourceConfigDir)).toEqual({
        MIMOCODE_CONFIG_DIR: sourceConfigDir
      })
      service.clearPty('pty-2')

      for (const sentinel of externalSentinels) {
        expect(readFileSync(sentinel, 'utf8')).toBe('EXTERNAL')
      }
    } finally {
      rmSync(externalDir, { recursive: true, force: true })
    }
  })

  it('does not use an untrusted PTY ID as an overlay path', () => {
    const service = new MimoCodeHookService()
    const env = service.buildPtyEnv('../outside', sourceConfigDir)

    expect(env.MIMOCODE_CONFIG_DIR).toBe(overlayConfigDir(userDataDir, '../outside'))
    expect(env.MIMOCODE_CONFIG_DIR).not.toContain(`..${process.platform === 'win32' ? '\\' : '/'}`)
  })

  it('excludes case variants of MiMo runtime state at the config root', () => {
    mkdirSync(join(sourceConfigDir, 'SeSsIoNs'), { recursive: true })
    writeFileSync(join(sourceConfigDir, 'AUTH.JSON'), 'USER AUTH')
    writeFileSync(join(sourceConfigDir, 'STATE.DB-WAL'), 'USER DATABASE')

    const service = new MimoCodeHookService()
    const overlayConfig = service.buildPtyEnv('pty-1', sourceConfigDir).MIMOCODE_CONFIG_DIR!

    expect(existsSync(join(overlayConfig, 'SeSsIoNs'))).toBe(false)
    expect(existsSync(join(overlayConfig, 'AUTH.JSON'))).toBe(false)
    expect(existsSync(join(overlayConfig, 'STATE.DB-WAL'))).toBe(false)
  })

  it('rejects a source inside the target tree without deleting or claiming it', () => {
    const overlayConfig = overlayConfigDir(userDataDir, 'pty-1')
    const nestedSource = join(overlayConfig, 'source')
    mkdirSync(nestedSource, { recursive: true })
    writeFileSync(join(nestedSource, 'sentinel'), 'SOURCE CONFIG')

    const service = new MimoCodeHookService()
    expect(service.buildPtyEnv('pty-1', nestedSource)).toEqual({
      MIMOCODE_CONFIG_DIR: nestedSource
    })
    service.clearPty('pty-1')

    expect(readFileSync(join(nestedSource, 'sentinel'), 'utf8')).toBe('SOURCE CONFIG')
  })

  it('rejects a target inside the source tree without registering ownership', () => {
    const sourceContainingTarget = join(userDataDir, 'mimocode-config-overlays')
    mkdirSync(sourceContainingTarget, { recursive: true })
    writeFileSync(join(sourceContainingTarget, 'sentinel'), 'SOURCE CONFIG')

    const service = new MimoCodeHookService()
    expect(service.buildPtyEnv('pty-1', sourceContainingTarget)).toEqual({
      MIMOCODE_CONFIG_DIR: sourceContainingTarget
    })
    service.clearPty('pty-1')

    expect(readFileSync(join(sourceContainingTarget, 'sentinel'), 'utf8')).toBe('SOURCE CONFIG')
  })

  it('rejects a source symlink whose real path is inside the target tree', () => {
    const overlayConfig = overlayConfigDir(userDataDir, 'pty-1')
    const nestedSource = join(overlayConfig, 'source')
    const sourceAlias = join(userDataDir, 'source-alias')
    mkdirSync(nestedSource, { recursive: true })
    writeFileSync(join(nestedSource, 'sentinel'), 'SOURCE CONFIG')
    symlinkSync(nestedSource, sourceAlias, process.platform === 'win32' ? 'junction' : 'dir')

    const service = new MimoCodeHookService()
    expect(service.buildPtyEnv('pty-1', sourceAlias)).toEqual({
      MIMOCODE_CONFIG_DIR: sourceAlias
    })
    service.clearPty('pty-1')

    expect(readFileSync(join(nestedSource, 'sentinel'), 'utf8')).toBe('SOURCE CONFIG')
  })

  it('rejects a target symlink whose real path is inside the source tree', () => {
    const overlayConfig = overlayConfigDir(userDataDir, 'pty-1')
    const nestedTarget = join(sourceConfigDir, 'nested-target')
    mkdirSync(join(userDataDir, 'mimocode-config-overlays'), { recursive: true })
    mkdirSync(nestedTarget)
    writeFileSync(join(nestedTarget, 'sentinel'), 'SOURCE CONFIG')
    symlinkSync(nestedTarget, overlayConfig, process.platform === 'win32' ? 'junction' : 'dir')

    const service = new MimoCodeHookService()
    expect(service.buildPtyEnv('pty-1', sourceConfigDir)).toEqual({
      MIMOCODE_CONFIG_DIR: sourceConfigDir
    })
    service.clearPty('pty-1')

    expect(readFileSync(join(nestedTarget, 'sentinel'), 'utf8')).toBe('SOURCE CONFIG')
  })

  it('does not clean or modify the source when it is the overlay path', () => {
    const overlayConfig = overlayConfigDir(userDataDir, 'pty-1')
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

    service.clearPty('pty-1')
    expect(readFileSync(join(overlayConfig, 'mimocode.json'), 'utf8')).toBe('SOURCE CONFIG')
  })

  it('does not clean a source that aliases the overlay path', () => {
    const overlayConfig = overlayConfigDir(userDataDir, 'pty-1')
    const sourceAlias = join(userDataDir, 'config-alias')
    mkdirSync(overlayConfig, { recursive: true })
    writeFileSync(join(overlayConfig, 'mimocode.json'), 'SOURCE CONFIG')
    symlinkSync(overlayConfig, sourceAlias, process.platform === 'win32' ? 'junction' : 'dir')

    const service = new MimoCodeHookService()
    expect(service.buildPtyEnv('pty-1', sourceAlias)).toEqual({
      MIMOCODE_CONFIG_DIR: sourceAlias
    })

    service.clearPty('pty-1')
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
    const service = new MimoCodeHookService()
    const overlayConfig = overlayConfigDir(userDataDir, 'pty-1')
    const residualConfig = join(overlayConfig, 'residual.json')
    mkdirSync(overlayConfig, { recursive: true })
    writeFileSync(residualConfig, 'RESIDUAL CONFIG')

    expect(service.buildPtyEnv('pty-1', sourceConfigDir)).toEqual({
      MIMOCODE_CONFIG_DIR: sourceConfigDir
    })
    expect(readFileSync(residualConfig, 'utf8')).toBe('RESIDUAL CONFIG')
    expect(existsSync(join(overlayConfig, 'plugins'))).toBe(false)
  })

  it('falls back before writing when cleanup leaves a plugins symlink', async () => {
    const overlayMirror = await import('../pty/overlay-mirror')
    vi.spyOn(overlayMirror, 'safeRemoveTree').mockImplementation(() => {})
    const service = new MimoCodeHookService()
    const overlayConfig = overlayConfigDir(userDataDir, 'pty-1')
    const linkedPluginsDir = mkdtempSync(join(tmpdir(), 'orca-mimocode-linked-plugins-'))
    mkdirSync(overlayConfig, { recursive: true })
    symlinkSync(
      linkedPluginsDir,
      join(overlayConfig, 'plugins'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    writeFileSync(join(linkedPluginsDir, 'orca-mimocode-status.js'), 'SOURCE PLUGIN')

    try {
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
