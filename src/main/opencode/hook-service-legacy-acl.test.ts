import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type * as NodeFs from 'node:fs'
import type * as Win32Utils from '../win32-utils'
import { setAppEnvironment } from '../../shared/app-environment'
import { openCodeTuiPluginDirName } from '../../shared/opencode-tui-plugin-install'
import {
  OpenCodeHookService,
  openCode2HookService,
  getOpenCodePluginSource,
  getOpenCode2PluginSource
} from './hook-service'

const fsMock = vi.hoisted(() => ({
  writeFileSync: vi.fn<typeof NodeFs.writeFileSync>(),
  mkdirSync: vi.fn<typeof NodeFs.mkdirSync>(),
  grantDirAcl: vi.fn<(directory: string) => void>()
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  fsMock.writeFileSync.mockImplementation(actual.writeFileSync)
  fsMock.mkdirSync.mockImplementation(actual.mkdirSync)
  return { ...actual, writeFileSync: fsMock.writeFileSync, mkdirSync: fsMock.mkdirSync }
})

vi.mock('../win32-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof Win32Utils>()),
  grantDirAcl: fsMock.grantDirAcl
}))

const hostPlatform = process.platform
const variants = [
  {
    hooks: 'opencode-hooks',
    file: 'orca-opencode-status.js',
    service: new OpenCodeHookService(),
    source: getOpenCodePluginSource
  },
  {
    hooks: 'opencode2-hooks',
    file: 'orca-opencode2-status.js',
    service: openCode2HookService,
    source: getOpenCode2PluginSource
  }
]

let root: string

beforeEach(async () => {
  const actual = await vi.importActual<typeof NodeFs>('node:fs')
  fsMock.writeFileSync.mockReset().mockImplementation(actual.writeFileSync)
  fsMock.mkdirSync.mockReset().mockImplementation(actual.mkdirSync)
  fsMock.grantDirAcl.mockReset()
  root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-legacy-plugin-acl-')))
  setAppEnvironment({
    getPath: () => root,
    getAppPath: () => process.cwd(),
    getVersion: () => '0.0.0-test',
    isPackaged: () => false,
    onWillQuit: () => {},
    exit: () => {},
    getAppMetrics: () => []
  })
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

function installedPlugin(variant: (typeof variants)[number]): {
  server: string
  tui: string
  source: string
} {
  const plugins = join(root, variant.hooks, 'shared', 'plugins')
  const server = join(plugins, variant.file)
  const tui = join(plugins, openCodeTuiPluginDirName(variant.file), 'tui.js')
  const source = variant.source()
  mkdirSync(dirname(tui), { recursive: true })
  writeFileSync(server, '// stale server')
  writeFileSync(tui, source)
  fsMock.writeFileSync.mockClear()
  fsMock.mkdirSync.mockClear()
  return { server, tui, source }
}

function tempWritesFor(target: string): string[] {
  return fsMock.writeFileSync.mock.calls
    .map(([file]) => String(file))
    .filter((file) => dirname(file) === dirname(target) && basename(file).startsWith('.'))
}

describe.each(variants)('$hooks legacy plugin ACL recovery', (variant) => {
  it.each(['EPERM', 'EACCES'])('retries one denied server generation after %s', async (code) => {
    const { server, tui, source } = installedPlugin(variant)
    const actual = await vi.importActual<typeof NodeFs>('node:fs')
    const denial = Object.assign(new Error('protected directory DACL'), { code })
    let attempts = 0
    fsMock.writeFileSync.mockImplementation((...args) => {
      expect(readFileSync(server, 'utf8')).toBe('// stale server')
      expect(readFileSync(tui, 'utf8')).toBe(source)
      actual.writeFileSync(...args)
      if (++attempts === 1) {
        throw denial
      }
    })

    variant.service.refreshLegacySharedPlugin()

    expect(readFileSync(server, 'utf8')).toBe(source)
    expect(fsMock.grantDirAcl).toHaveBeenCalledExactlyOnceWith(dirname(server))
    const generations = tempWritesFor(server)
    expect(generations).toHaveLength(2)
    expect(new Set(generations).size).toBe(2)
    expect(generations.every((path) => !existsSync(path))).toBe(true)
    expect(fsMock.grantDirAcl.mock.invocationCallOrder[0]).toBeGreaterThan(
      fsMock.writeFileSync.mock.invocationCallOrder[0]
    )
    expect(fsMock.grantDirAcl.mock.invocationCallOrder[0]).toBeLessThan(
      fsMock.writeFileSync.mock.invocationCallOrder[1]
    )
    expect(console.warn).not.toHaveBeenCalled()
  })

  it('recovers a denied mkdir in the shared atomic server writer', async () => {
    const { server, source } = installedPlugin(variant)
    const actual = await vi.importActual<typeof NodeFs>('node:fs')
    fsMock.mkdirSync
      .mockImplementationOnce(() => {
        throw Object.assign(new Error('mkdir denied'), { code: 'EPERM' })
      })
      .mockImplementation(actual.mkdirSync)

    variant.service.refreshLegacySharedPlugin()

    expect(fsMock.grantDirAcl).toHaveBeenCalledExactlyOnceWith(dirname(server))
    expect(fsMock.mkdirSync).toHaveBeenCalledTimes(2)
    expect(readFileSync(server, 'utf8')).toBe(source)
  })

  it('grants the existing parent when creation of the TUI directory is denied', async () => {
    const { server, tui, source } = installedPlugin(variant)
    rmSync(dirname(tui), { recursive: true })
    const actual = await vi.importActual<typeof NodeFs>('node:fs')
    fsMock.mkdirSync
      .mockImplementationOnce(() => {
        throw Object.assign(new Error('TUI mkdir denied'), { code: 'EACCES' })
      })
      .mockImplementation(actual.mkdirSync)
    fsMock.writeFileSync.mockImplementation((...args) => {
      if (dirname(String(args[0])) === dirname(server)) {
        expect(readFileSync(tui, 'utf8')).toBe(source)
      }
      return actual.writeFileSync(...args)
    })

    variant.service.refreshLegacySharedPlugin()

    expect(fsMock.grantDirAcl).toHaveBeenCalledExactlyOnceWith(dirname(server))
    expect(readFileSync(tui, 'utf8')).toBe(source)
    expect(readFileSync(server, 'utf8')).toBe(source)
  })

  it('recovers a denied TUI write before replacing the server plugin', async () => {
    const { server, tui, source } = installedPlugin(variant)
    writeFileSync(tui, '// stale TUI')
    fsMock.writeFileSync.mockClear()
    const actual = await vi.importActual<typeof NodeFs>('node:fs')
    let denied = false
    fsMock.writeFileSync.mockImplementation((...args) => {
      if (dirname(String(args[0])) === dirname(tui) && !denied) {
        denied = true
        throw Object.assign(new Error('TUI write denied'), { code: 'EPERM' })
      }
      if (dirname(String(args[0])) === dirname(server)) {
        expect(readFileSync(tui, 'utf8')).toBe(source)
      }
      return actual.writeFileSync(...args)
    })

    variant.service.refreshLegacySharedPlugin()

    expect(fsMock.grantDirAcl).toHaveBeenCalledExactlyOnceWith(dirname(tui))
    expect(tempWritesFor(tui)).toHaveLength(2)
    expect(readFileSync(server, 'utf8')).toBe(source)
  })

  it('keeps the old server when TUI recovery still fails', () => {
    const { server, tui } = installedPlugin(variant)
    writeFileSync(tui, '// stale TUI')
    fsMock.writeFileSync.mockClear()
    const denial = Object.assign(new Error('TUI generation denied'), { code: 'EPERM' })
    fsMock.writeFileSync.mockImplementation(() => {
      throw denial
    })

    variant.service.refreshLegacySharedPlugin()

    expect(fsMock.grantDirAcl).toHaveBeenCalledExactlyOnceWith(dirname(tui))
    expect(tempWritesFor(tui)).toHaveLength(2)
    expect(tempWritesFor(server)).toHaveLength(0)
    expect(readFileSync(tui, 'utf8')).toBe('// stale TUI')
    expect(readFileSync(server, 'utf8')).toBe('// stale server')
    expect(console.warn).toHaveBeenCalledWith(expect.any(String), server, denial)
  })

  it.each(['darwin', 'linux'] as const)('does not grant or retry on %s', (platform) => {
    const { server } = installedPlugin(variant)
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
    const denial = Object.assign(new Error('write denied'), { code: 'EPERM' })
    fsMock.writeFileSync.mockImplementation(() => {
      throw denial
    })

    variant.service.refreshLegacySharedPlugin()

    expect(tempWritesFor(server)).toHaveLength(1)
    expect(fsMock.grantDirAcl).not.toHaveBeenCalled()
    expect(readFileSync(server, 'utf8')).toBe('// stale server')
    expect(console.warn).toHaveBeenCalledWith(expect.any(String), server, denial)
  })

  it.each(['EIO', 'ENOSPC', 'EBUSY', 'ENOENT'])('does not retry an unrelated %s error', (code) => {
    const { server } = installedPlugin(variant)
    fsMock.writeFileSync.mockImplementation(() => {
      throw Object.assign(new Error('unrelated failure'), { code })
    })

    variant.service.refreshLegacySharedPlugin()

    expect(tempWritesFor(server)).toHaveLength(1)
    expect(fsMock.grantDirAcl).not.toHaveBeenCalled()
    expect(readFileSync(server, 'utf8')).toBe('// stale server')
  })

  it.each(['grant', 'retry'])('keeps the original denial when the %s fails', (failure) => {
    const { server } = installedPlugin(variant)
    const original = Object.assign(new Error('original denial'), { code: 'EPERM' })
    const later = Object.assign(new Error('later failure'), { code: 'EACCES' })
    fsMock.writeFileSync
      .mockImplementationOnce(() => {
        throw original
      })
      .mockImplementation(() => {
        throw later
      })
    if (failure === 'grant') {
      fsMock.grantDirAcl.mockImplementation(() => {
        throw later
      })
    }

    variant.service.refreshLegacySharedPlugin()

    expect(fsMock.grantDirAcl).toHaveBeenCalledExactlyOnceWith(dirname(server))
    expect(tempWritesFor(server)).toHaveLength(failure === 'grant' ? 1 : 2)
    expect(console.warn).toHaveBeenCalledWith(expect.any(String), server, original)
    expect(readFileSync(server, 'utf8')).toBe('// stale server')
    expect(readdirSync(dirname(server)).some((name) => name.endsWith('.tmp'))).toBe(false)
  })

  it.skipIf(hostPlatform === 'win32')(
    'repairs the canonical target directory and preserves its link',
    async () => {
      const { server, source } = installedPlugin(variant)
      const target = join(root, 'dotfiles', 'status.js')
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, '// stale target')
      rmSync(server)
      symlinkSync(target, server)
      fsMock.writeFileSync.mockClear()
      const actual = await vi.importActual<typeof NodeFs>('node:fs')
      fsMock.writeFileSync
        .mockImplementationOnce(() => {
          throw Object.assign(new Error('target denied'), { code: 'EPERM' })
        })
        .mockImplementation(actual.writeFileSync)

      variant.service.refreshLegacySharedPlugin()

      expect(fsMock.grantDirAcl).toHaveBeenCalledExactlyOnceWith(dirname(target))
      expect(lstatSync(server).isSymbolicLink()).toBe(true)
      expect(readFileSync(target, 'utf8')).toBe(source)
    }
  )

  it('leaves current and absent installs alone', () => {
    variant.service.refreshLegacySharedPlugin()
    expect(existsSync(join(root, variant.hooks))).toBe(false)
    const { server, source } = installedPlugin(variant)
    writeFileSync(server, source)
    fsMock.writeFileSync.mockClear()
    fsMock.mkdirSync.mockClear()

    variant.service.refreshLegacySharedPlugin()

    expect(fsMock.grantDirAcl).not.toHaveBeenCalled()
    expect(fsMock.writeFileSync).not.toHaveBeenCalled()
    expect(fsMock.mkdirSync).not.toHaveBeenCalled()
  })
})
