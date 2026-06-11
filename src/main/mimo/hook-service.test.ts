import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const { getPathMock } = vi.hoisted(() => ({
  getPathMock: vi.fn<(name: string) => string>()
}))

vi.mock('electron', () => ({
  app: {
    getPath: getPathMock
  }
}))

import { MimoHookService, _internals } from './hook-service'

const { isUsableId, toSafeDirName } = _internals

describe('Mimo id safety guard', () => {
  it('accepts the daemon-path sessionId shape (worktreeId@@uuid with ::/...)', () => {
    const daemonSessionId =
      '50c010a2-bc8e-4eb1-8847-5812133ad6df::/Users/thebr/ghostx/workspaces/noqa/autoheal@@a1b2c3d4'
    expect(isUsableId(daemonSessionId)).toBe(true)
  })

  it('accepts ids at the inclusive upper length bound', () => {
    expect(isUsableId('x'.repeat(1024))).toBe(true)
  })

  it('rejects empty or oversized ids', () => {
    expect(isUsableId('')).toBe(false)
    expect(isUsableId('x'.repeat(1025))).toBe(false)
  })

  it('rejects non-string runtime values even though the type says string', () => {
    expect(isUsableId(undefined as unknown as string)).toBe(false)
    expect(isUsableId(null as unknown as string)).toBe(false)
    expect(isUsableId(42 as unknown as string)).toBe(false)
  })

  it('derives a filesystem-safe directory name independent of the raw id', () => {
    const name = toSafeDirName('50c010::/Users/thebr/x/y@@uuid')
    expect(name).toMatch(/^[0-9a-f]{32}$/)
  })

  it('is stable across calls for the same id', () => {
    const id = 'some-session-id'
    expect(toSafeDirName(id)).toBe(toSafeDirName(id))
  })

  it('produces different names for different ids', () => {
    expect(toSafeDirName('a')).not.toBe(toSafeDirName('b'))
  })
})

describe('MimoHookService buildPtyEnv / clearPty round-trip', () => {
  const daemonSessionId =
    '50c010a2-bc8e-4eb1-8847-5812133ad6df::/Users/thebr/ghostx/workspaces/noqa/autoheal@@a1b2c3d4'
  const plainUuidId = 'c0ffee00-0000-4000-8000-000000000000'
  let userDataDir: string

  beforeAll(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'orca-mimo-hooks-'))
    getPathMock.mockImplementation((name: string) => {
      if (name === 'userData') {
        return userDataDir
      }
      throw new Error(`unexpected getPath(${name})`)
    })
  })

  afterAll(() => {
    rmSync(userDataDir, { recursive: true, force: true })
  })

  afterEach(() => {
    rmSync(join(userDataDir, 'mimo-hooks'), { recursive: true, force: true })
    rmSync(join(userDataDir, 'mimo-config-overlays'), { recursive: true, force: true })
  })

  it('writes a shared MIMO_CONFIG_DIR and installs the plugin file', () => {
    const service = new MimoHookService()
    const env = service.buildPtyEnv(daemonSessionId)

    expect(env.MIMO_CONFIG_DIR).toBeTruthy()
    expect(env.MIMO_CONFIG_DIR).toBe(join(userDataDir, 'mimo-hooks', 'shared'))

    const pluginPath = join(env.MIMO_CONFIG_DIR!, 'plugins', 'orca-mimo-status.js')
    expect(existsSync(pluginPath)).toBe(true)
    const pluginSource = readFileSync(pluginPath, 'utf8')
    expect(pluginSource).toContain('OrcaMimoStatusPlugin')
    expect(pluginSource).toContain('messageID: part.messageID')
  })

  it('clearPty leaves the shared Mimo config dir off the teardown hot path', () => {
    const service = new MimoHookService()
    const env = service.buildPtyEnv(daemonSessionId)
    const configDir = env.MIMO_CONFIG_DIR!
    expect(existsSync(configDir)).toBe(true)
    mkdirSync(join(configDir, 'node_modules', 'mimo-runtime'), { recursive: true })
    writeFileSync(join(configDir, 'node_modules', 'mimo-runtime', 'index.js'), '')

    service.clearPty(daemonSessionId)
    expect(existsSync(configDir)).toBe(true)
    expect(existsSync(join(configDir, 'node_modules', 'mimo-runtime', 'index.js'))).toBe(true)
  })

  it('buildPtyEnv returns {} for an unusable id and creates nothing on disk', () => {
    const service = new MimoHookService()
    const hooksRoot = join(userDataDir, 'mimo-hooks')
    const overlaysRoot = join(userDataDir, 'mimo-config-overlays')

    expect(service.buildPtyEnv('')).toEqual({})
    expect(existsSync(hooksRoot)).toBe(false)
    expect(existsSync(overlaysRoot)).toBe(false)
  })

  it('buildPtyEnv preserves a user-set MIMO_CONFIG_DIR when the id is unusable', () => {
    const service = new MimoHookService()
    const userDir = mkdtempSync(join(tmpdir(), 'orca-mimo-userdir-'))
    try {
      expect(service.buildPtyEnv('', userDir)).toEqual({ MIMO_CONFIG_DIR: userDir })
    } finally {
      rmSync(userDir, { recursive: true, force: true })
    }
  })

  it('works end-to-end for a plain UUID id (non-daemon path)', () => {
    const service = new MimoHookService()
    const env = service.buildPtyEnv(plainUuidId)

    expect(env.MIMO_CONFIG_DIR).toBe(join(userDataDir, 'mimo-hooks', 'shared'))
    expect(existsSync(join(env.MIMO_CONFIG_DIR!, 'plugins', 'orca-mimo-status.js'))).toBe(true)

    service.clearPty(plainUuidId)
    expect(existsSync(env.MIMO_CONFIG_DIR!)).toBe(true)
  })
})

describe('MimoHookService overlay mode (user MIMO_CONFIG_DIR set)', () => {
  const ptyId = 'overlay-pty-1'
  let userDataDir: string
  let userConfigDir: string

  beforeAll(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'orca-mimo-overlay-userdata-'))
    getPathMock.mockImplementation((name: string) => {
      if (name === 'userData') {
        return userDataDir
      }
      throw new Error(`unexpected getPath(${name})`)
    })
  })

  afterAll(() => {
    rmSync(userDataDir, { recursive: true, force: true })
  })

  beforeEach(() => {
    userConfigDir = mkdtempSync(join(tmpdir(), 'orca-mimo-overlay-userconfig-'))
    writeFileSync(join(userConfigDir, 'mimo.json'), '{"userTheme":"solarized"}')
    writeFileSync(join(userConfigDir, 'auth.json'), 'user-auth-token')
    mkdirSync(join(userConfigDir, 'plugins'), { recursive: true })
    writeFileSync(join(userConfigDir, 'plugins', 'user-plugin.js'), 'export default () => {}')
  })

  afterEach(() => {
    rmSync(userConfigDir, { recursive: true, force: true })
    rmSync(join(userDataDir, 'mimo-hooks'), { recursive: true, force: true })
    rmSync(join(userDataDir, 'mimo-config-overlays'), { recursive: true, force: true })
  })

  function expectUserConfigIntact(): void {
    expect(readFileSync(join(userConfigDir, 'mimo.json'), 'utf8')).toBe('{"userTheme":"solarized"}')
    expect(readFileSync(join(userConfigDir, 'auth.json'), 'utf8')).toBe('user-auth-token')
    expect(readFileSync(join(userConfigDir, 'plugins', 'user-plugin.js'), 'utf8')).toBe(
      'export default () => {}'
    )
  }

  it('builds an overlay under userData and exposes user config + Orca plugin together', () => {
    const service = new MimoHookService()
    const env = service.buildPtyEnv(ptyId, userConfigDir)

    expect(env.MIMO_CONFIG_DIR).toBe(
      join(userDataDir, 'mimo-config-overlays', toSafeDirName(`source:${userConfigDir}`))
    )
    expect(env.MIMO_CONFIG_DIR).not.toBe(userConfigDir)

    expect(readFileSync(join(env.MIMO_CONFIG_DIR!, 'mimo.json'), 'utf8')).toBe(
      '{"userTheme":"solarized"}'
    )
    expect(readFileSync(join(env.MIMO_CONFIG_DIR!, 'auth.json'), 'utf8')).toBe('user-auth-token')
    expect(readFileSync(join(env.MIMO_CONFIG_DIR!, 'plugins', 'user-plugin.js'), 'utf8')).toBe(
      'export default () => {}'
    )

    const orcaPluginPath = join(env.MIMO_CONFIG_DIR!, 'plugins', 'orca-mimo-status.js')
    expect(existsSync(orcaPluginPath)).toBe(true)
    expect(readFileSync(orcaPluginPath, 'utf8')).toContain('OrcaMimoStatusPlugin')

    expectUserConfigIntact()
  })

  it.skipIf(process.platform === 'win32')(
    'mirrors top-level entries via symlinks so plugins/ is a real directory',
    () => {
      const service = new MimoHookService()
      const env = service.buildPtyEnv(ptyId, userConfigDir)

      const overlay = env.MIMO_CONFIG_DIR!
      expect(lstatSync(join(overlay, 'mimo.json')).isSymbolicLink()).toBe(true)
      expect(lstatSync(join(overlay, 'auth.json')).isSymbolicLink()).toBe(true)
      expect(lstatSync(join(overlay, 'plugins')).isDirectory()).toBe(true)
      expect(lstatSync(join(overlay, 'plugins')).isSymbolicLink()).toBe(false)
      expect(lstatSync(join(overlay, 'plugins', 'user-plugin.js')).isSymbolicLink()).toBe(true)
    }
  )

  it("does not overwrite a user plugin file with the same filename as Orca's plugin", () => {
    const userOrcaSentinel = 'USER OWNED ORCA-NAMED PLUGIN — DO NOT CLOBBER'
    writeFileSync(join(userConfigDir, 'plugins', 'orca-mimo-status.js'), userOrcaSentinel)

    const service = new MimoHookService()
    const env = service.buildPtyEnv(ptyId, userConfigDir)

    expect(readFileSync(join(userConfigDir, 'plugins', 'orca-mimo-status.js'), 'utf8')).toBe(
      userOrcaSentinel
    )

    const overlayPlugin = readFileSync(
      join(env.MIMO_CONFIG_DIR!, 'plugins', 'orca-mimo-status.js'),
      'utf8'
    )
    expect(overlayPlugin).toContain('OrcaMimoStatusPlugin')
    expect(overlayPlugin).not.toBe(userOrcaSentinel)
    expectUserConfigIntact()
  })

  it.skipIf(process.platform === 'win32')(
    'does not write through a symlinked plugins/ directory into the user filesystem',
    () => {
      const realPluginsDir = mkdtempSync(join(tmpdir(), 'orca-real-plugins-'))
      try {
        writeFileSync(join(realPluginsDir, 'real-plugin.js'), 'REAL USER PLUGIN')

        rmSync(join(userConfigDir, 'plugins'), { recursive: true, force: true })
        symlinkSync(realPluginsDir, join(userConfigDir, 'plugins'), 'dir')

        const service = new MimoHookService()
        const env = service.buildPtyEnv(ptyId, userConfigDir)

        expect(existsSync(join(realPluginsDir, 'orca-mimo-status.js'))).toBe(false)
        expect(lstatSync(join(env.MIMO_CONFIG_DIR!, 'plugins')).isSymbolicLink()).toBe(false)
        expect(existsSync(join(env.MIMO_CONFIG_DIR!, 'plugins', 'orca-mimo-status.js'))).toBe(true)
        expect(readFileSync(join(env.MIMO_CONFIG_DIR!, 'plugins', 'real-plugin.js'), 'utf8')).toBe(
          'REAL USER PLUGIN'
        )
      } finally {
        rmSync(realPluginsDir, { recursive: true, force: true })
      }
    }
  )

  it("preserves the user's MIMO_CONFIG_DIR when the path does not exist", () => {
    const service = new MimoHookService()
    const missingPath = join(tmpdir(), `orca-mimo-nope-${Date.now()}`)
    expect(existsSync(missingPath)).toBe(false)

    const env = service.buildPtyEnv(ptyId, missingPath)
    expect(env).toEqual({ MIMO_CONFIG_DIR: missingPath })
    expect(existsSync(missingPath)).toBe(false)
    expect(
      existsSync(join(userDataDir, 'mimo-config-overlays', toSafeDirName(`source:${missingPath}`)))
    ).toBe(false)
  })

  it("preserves the user's MIMO_CONFIG_DIR when the mirror step fails", async () => {
    const overlayMirror = await import('../pty/overlay-mirror')
    const mirrorSpy = vi.spyOn(overlayMirror, 'mirrorEntry').mockImplementation(() => {
      throw new Error('simulated EPERM on symlink')
    })
    try {
      const service = new MimoHookService()
      const env = service.buildPtyEnv(ptyId, userConfigDir)
      expect(env).toEqual({ MIMO_CONFIG_DIR: userConfigDir })
      const overlayDir = join(
        userDataDir,
        'mimo-config-overlays',
        toSafeDirName(`source:${userConfigDir}`)
      )
      expect(existsSync(overlayDir)).toBe(true)
      expectUserConfigIntact()
    } finally {
      mirrorSpy.mockRestore()
    }
  })

  it.skipIf(process.platform === 'win32')(
    'clearPty leaves the source overlay off the teardown hot path',
    () => {
      const service = new MimoHookService()
      service.buildPtyEnv(ptyId, userConfigDir)

      const overlayDir = join(
        userDataDir,
        'mimo-config-overlays',
        toSafeDirName(`source:${userConfigDir}`)
      )
      expect(existsSync(overlayDir)).toBe(true)

      service.clearPty(ptyId)

      expect(existsSync(overlayDir)).toBe(true)
      expectUserConfigIntact()
      expect(readdirSync(join(userConfigDir, 'plugins'))).toEqual(['user-plugin.js'])
    }
  )

  it('rebuilding the overlay for the same ptyId does not corrupt the user dir', () => {
    const service = new MimoHookService()
    service.buildPtyEnv(ptyId, userConfigDir)
    service.buildPtyEnv(ptyId, userConfigDir)
    const env = service.buildPtyEnv(ptyId, userConfigDir)

    expect(
      readFileSync(join(env.MIMO_CONFIG_DIR!, 'plugins', 'orca-mimo-status.js'), 'utf8')
    ).toContain('OrcaMimoStatusPlugin')
    expectUserConfigIntact()
  })

  it('reconciles stale mirrored entries while preserving Mimo runtime files', () => {
    const service = new MimoHookService()
    const firstEnv = service.buildPtyEnv(ptyId, userConfigDir)
    const overlayDir = firstEnv.MIMO_CONFIG_DIR!

    mkdirSync(join(overlayDir, 'node_modules', 'mimo-runtime'), { recursive: true })
    writeFileSync(join(overlayDir, 'node_modules', 'mimo-runtime', 'index.js'), '')

    rmSync(join(userConfigDir, 'auth.json'), { force: true })
    writeFileSync(join(userConfigDir, 'auth.json'), 'rotated-user-auth-token')
    rmSync(join(userConfigDir, 'plugins', 'user-plugin.js'), { force: true })
    writeFileSync(join(userConfigDir, 'plugins', 'new-plugin.js'), 'export default "new"')

    const secondEnv = service.buildPtyEnv(ptyId, userConfigDir)

    expect(secondEnv.MIMO_CONFIG_DIR).toBe(overlayDir)
    expect(readFileSync(join(overlayDir, 'auth.json'), 'utf8')).toBe('rotated-user-auth-token')
    expect(existsSync(join(overlayDir, 'plugins', 'user-plugin.js'))).toBe(false)
    expect(readFileSync(join(overlayDir, 'plugins', 'new-plugin.js'), 'utf8')).toBe(
      'export default "new"'
    )
    expect(existsSync(join(overlayDir, 'node_modules', 'mimo-runtime', 'index.js'))).toBe(true)
  })
})
