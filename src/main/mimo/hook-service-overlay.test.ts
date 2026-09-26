import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeFs from 'node:fs'
import type * as NodeOs from 'node:os'
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setAppEnvironment } from '../../shared/app-environment'
import { MimoCodeHookService } from './hook-service'

const { homedirMock } = vi.hoisted(() => ({ homedirMock: vi.fn<() => string>() }))
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeOs>()),
  homedir: homedirMock
}))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  return {
    ...actual,
    unlinkSync: vi.fn(actual.unlinkSync),
    writeFileSync: vi.fn(actual.writeFileSync)
  }
})

let fixture: string
let sourceHome: string
let sourceConfig: string
let userPlugins: string
let overlayHome: string
let overlayConfig: string
let overlayPlugins: string
const filename = 'orca-mimocode-status.js'
const sentinel = 'USER OWNED PLUGIN'
const directoryLinkType = process.platform === 'win32' ? 'junction' : 'dir'

beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), 'orca-mimo-overlay-'))
  sourceHome = join(fixture, 'source-home')
  sourceConfig = join(sourceHome, 'config')
  userPlugins = join(fixture, 'user-plugins')
  overlayHome = join(fixture, 'userdata', 'mimocode-hooks', 'shared')
  overlayConfig = join(overlayHome, 'config')
  overlayPlugins = join(overlayConfig, 'plugins')
  mkdirSync(sourceConfig, { recursive: true })
  mkdirSync(userPlugins)
  homedirMock.mockReturnValue(join(fixture, 'unused-home'))
  setAppEnvironment({
    getPath: () => join(fixture, 'userdata'),
    getAppPath: () => process.cwd(),
    getVersion: () => '0.0.0-test',
    isPackaged: () => false,
    onWillQuit: () => {},
    exit: () => {},
    getAppMetrics: () => []
  })
})

afterEach(() => {
  vi.mocked(unlinkSync).mockReset()
  vi.mocked(writeFileSync).mockClear()
  rmSync(fixture, { recursive: true, force: true })
})

function linkPlugins(): void {
  symlinkSync(userPlugins, join(sourceConfig, 'plugins'), directoryLinkType)
}

function expectInstalled(): void {
  expect(new MimoCodeHookService().buildPtyEnv('pane', sourceHome)).toEqual({
    MIMOCODE_HOME: overlayHome
  })
  expect(readFileSync(join(overlayPlugins, filename), 'utf8')).toContain('/hook/mimo-code')
}

describe('MiMo overlay source preservation', () => {
  it('preserves a same-named user plugin behind a linked directory', () => {
    linkPlugins()
    writeFileSync(join(userPlugins, filename), sentinel)
    writeFileSync(join(userPlugins, 'user.js'), 'USER EXTENSION')
    expectInstalled()
    expect(readFileSync(join(userPlugins, filename), 'utf8')).toBe(sentinel)
    expect(lstatSync(overlayPlugins).isSymbolicLink()).toBe(false)
    expect(readFileSync(join(overlayPlugins, 'user.js'), 'utf8')).toBe('USER EXTENSION')
  })

  it('keeps a linked user directory free of an absent Orca filename', () => {
    linkPlugins()
    expectInstalled()
    expect(existsSync(join(userPlugins, filename))).toBe(false)
  })

  it.skipIf(process.platform === 'win32')(
    'preserves user plugin symlinks and their targets',
    () => {
      linkPlugins()
      const target = join(fixture, 'plugin-target.js')
      writeFileSync(target, sentinel)
      symlinkSync(target, join(userPlugins, filename), 'file')
      symlinkSync(target, join(userPlugins, 'user.js'), 'file')
      expectInstalled()
      expect(readFileSync(target, 'utf8')).toBe(sentinel)
      expect(lstatSync(join(userPlugins, filename)).isSymbolicLink()).toBe(true)
      expect(readFileSync(join(overlayPlugins, 'user.js'), 'utf8')).toBe(sentinel)
    }
  )

  it('keeps an ordinary real plugins directory unchanged', () => {
    mkdirSync(join(sourceConfig, 'plugins'))
    writeFileSync(join(sourceConfig, 'plugins', filename), sentinel)
    expectInstalled()
    expect(readFileSync(join(sourceConfig, 'plugins', filename), 'utf8')).toBe(sentinel)
  })

  it('preserves a broken plugins directory link and falls back to the source home', () => {
    linkPlugins()
    rmSync(userPlugins, { recursive: true })
    expect(new MimoCodeHookService().buildPtyEnv('pane', sourceHome)).toEqual({
      MIMOCODE_HOME: sourceHome
    })
    expect(lstatSync(join(sourceConfig, 'plugins')).isSymbolicLink()).toBe(true)
    expect(existsSync(userPlugins)).toBe(false)
  })

  it('preserves a plugins file that cannot host the managed plugin', () => {
    writeFileSync(join(sourceConfig, 'plugins'), sentinel)
    expect(new MimoCodeHookService().buildPtyEnv('pane', sourceHome)).toEqual({
      MIMOCODE_HOME: sourceHome
    })
    expect(readFileSync(join(sourceConfig, 'plugins'), 'utf8')).toBe(sentinel)
  })

  it('replaces stale overlay links without removing source files or runtime data', () => {
    linkPlugins()
    writeFileSync(join(userPlugins, filename), sentinel)
    writeFileSync(join(userPlugins, 'old.js'), 'OLD')
    mkdirSync(overlayConfig, { recursive: true })
    symlinkSync(userPlugins, overlayPlugins, directoryLinkType)
    for (const name of ['data', 'cache', 'state']) {
      mkdirSync(join(overlayHome, name))
      writeFileSync(join(overlayHome, name, 'runtime'), name)
    }
    expectInstalled()
    rmSync(join(userPlugins, 'old.js'))
    writeFileSync(join(userPlugins, 'new.js'), 'NEW')
    expectInstalled()
    expect(existsSync(join(overlayPlugins, 'old.js'))).toBe(false)
    expect(readFileSync(join(overlayPlugins, 'new.js'), 'utf8')).toBe('NEW')
    expect(readFileSync(join(userPlugins, filename), 'utf8')).toBe(sentinel)
    for (const name of ['data', 'cache', 'state']) {
      expect(readFileSync(join(overlayHome, name, 'runtime'), 'utf8')).toBe(name)
    }
  })

  it('does not write through a linked config directory after failed cleanup', () => {
    mkdirSync(overlayHome, { recursive: true })
    symlinkSync(userPlugins, overlayConfig, directoryLinkType)
    const denied = Object.assign(new Error('cleanup denied'), { code: 'EPERM' })
    vi.mocked(unlinkSync).mockImplementation(() => {
      throw denied
    })
    writeFileSync(join(userPlugins, filename), sentinel)
    expect(new MimoCodeHookService().buildPtyEnv('pane', sourceHome)).toEqual({
      MIMOCODE_HOME: sourceHome
    })
    expect(existsSync(join(userPlugins, 'plugins'))).toBe(false)
    expect(readFileSync(join(userPlugins, filename), 'utf8')).toBe(sentinel)
  })

  it.each(['config', 'plugins'])('refuses a retained %s directory link with no source', (name) => {
    rmSync(sourceConfig, { recursive: true })
    mkdirSync(overlayHome, { recursive: true })
    if (name === 'config') {
      symlinkSync(userPlugins, overlayConfig, directoryLinkType)
    } else {
      mkdirSync(overlayConfig)
      symlinkSync(userPlugins, overlayPlugins, directoryLinkType)
    }
    expect(new MimoCodeHookService().buildPtyEnv('pane', sourceHome)).toEqual({
      MIMOCODE_HOME: sourceHome
    })
    expect(existsSync(join(userPlugins, filename))).toBe(false)
    expect(existsSync(join(userPlugins, 'plugins'))).toBe(false)
  })

  it('detaches a retained plugin hardlink before writing without a source config', () => {
    rmSync(sourceConfig, { recursive: true })
    mkdirSync(overlayPlugins, { recursive: true })
    const target = join(userPlugins, filename)
    writeFileSync(target, sentinel)
    linkSync(target, join(overlayPlugins, filename))
    expectInstalled()
    expect(readFileSync(target, 'utf8')).toBe(sentinel)
  })

  it('does not fall through to a write after unlink is denied', () => {
    rmSync(sourceConfig, { recursive: true })
    mkdirSync(overlayPlugins, { recursive: true })
    const target = join(userPlugins, filename)
    writeFileSync(target, sentinel)
    linkSync(target, join(overlayPlugins, filename))
    const denied = Object.assign(new Error('unlink denied'), { code: 'EPERM' })
    vi.mocked(unlinkSync).mockImplementation(() => {
      throw denied
    })
    vi.mocked(writeFileSync).mockClear()
    expect(new MimoCodeHookService().buildPtyEnv('pane', sourceHome)).toEqual({
      MIMOCODE_HOME: sourceHome
    })
    expect(writeFileSync).not.toHaveBeenCalled()
    expect(readFileSync(target, 'utf8')).toBe(sentinel)
  })

  it('refuses a file link inserted after the old plugin was removed', async () => {
    rmSync(sourceConfig, { recursive: true })
    mkdirSync(overlayPlugins, { recursive: true })
    const target = join(userPlugins, filename)
    const pluginPath = join(overlayPlugins, filename)
    writeFileSync(target, sentinel)
    linkSync(target, pluginPath)
    const actual = await vi.importActual<typeof NodeFs>('node:fs')
    vi.mocked(unlinkSync).mockImplementation((path) => {
      actual.unlinkSync(path)
      linkSync(target, pluginPath)
    })
    expect(new MimoCodeHookService().buildPtyEnv('pane', sourceHome)).toEqual({
      MIMOCODE_HOME: sourceHome
    })
    expect(readFileSync(target, 'utf8')).toBe(sentinel)
  })
})
