import {
  chmodSync,
  linkSync,
  lstatSync,
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
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KimiHookService } from './hook-service'

// Isolate homedir (HOME/USERPROFILE) and KIMI_CODE_HOME so installs cannot touch real configs.
let home: string
let originalHome: string | undefined
let originalKimiHome: string | undefined
let originalUserProfile: string | undefined

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orca-kimi-hook-'))
  originalHome = process.env.HOME
  originalKimiHome = process.env.KIMI_CODE_HOME
  originalUserProfile = process.env.USERPROFILE
  process.env.HOME = home
  process.env.KIMI_CODE_HOME = join(home, '.kimi-code')
  process.env.USERPROFILE = home
})

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.HOME
  } else {
    process.env.HOME = originalHome
  }
  if (originalKimiHome === undefined) {
    delete process.env.KIMI_CODE_HOME
  } else {
    process.env.KIMI_CODE_HOME = originalKimiHome
  }
  if (originalUserProfile === undefined) {
    delete process.env.USERPROFILE
  } else {
    process.env.USERPROFILE = originalUserProfile
  }
  for (const path of [configPath(), `${configPath()}.bak`]) {
    try {
      chmodSync(path, 0o666)
    } catch {
      // Absent.
    }
  }
  rmSync(home, { recursive: true, force: true })
})

const configPath = (): string => join(home, '.kimi-code', 'config.toml')
const supportsPosixFileModes = process.platform !== 'win32'

describe('KimiHookService', () => {
  it.skipIf(!supportsPosixFileModes)(
    'preserves an existing config mode while installing and removing hooks',
    () => {
      mkdirSync(join(home, '.kimi-code'), { recursive: true })
      writeFileSync(configPath(), 'api_key = "sk-secret"\n')
      const existingMode = 0o640
      chmodSync(configPath(), existingMode)

      const service = new KimiHookService()
      const originalUmask = process.umask(0o077)
      try {
        service.install()
        expect(statSync(configPath()).mode & 0o777).toBe(existingMode)
        expect(statSync(`${configPath()}.bak`).mode & 0o777).toBe(existingMode)
        expect(
          readdirSync(join(home, '.kimi-code')).filter((name) => name.endsWith('.tmp'))
        ).toEqual([])

        service.remove()
        expect(statSync(configPath()).mode & 0o777).toBe(existingMode)
      } finally {
        process.umask(originalUmask)
      }
    }
  )

  it.skipIf(!supportsPosixFileModes)('creates a new config with an owner-only mode', () => {
    const originalUmask = process.umask(0o022)
    try {
      new KimiHookService().install()

      expect(statSync(configPath()).mode & 0o777).toBe(0o600)
    } finally {
      process.umask(originalUmask)
    }
  })

  it('replaces a hard-linked backup without modifying the unrelated inode', () => {
    const dir = join(home, '.kimi-code')
    mkdirSync(dir, { recursive: true })
    const initial = 'model = "kimi-k2"\n'
    writeFileSync(configPath(), initial)
    const unrelated = join(dir, 'unrelated.toml')
    writeFileSync(unrelated, 'preserve = true\n')
    linkSync(unrelated, `${configPath()}.bak`)

    expect(new KimiHookService().install().state).toBe('installed')
    expect(readFileSync(unrelated, 'utf-8')).toBe('preserve = true\n')
    expect(readFileSync(`${configPath()}.bak`, 'utf-8')).toBe(initial)
  })

  it.skipIf(!supportsPosixFileModes)(
    'refuses a symlinked backup without touching its target',
    () => {
      const dir = join(home, '.kimi-code')
      mkdirSync(dir, { recursive: true })
      const initial = 'model = "kimi-k2"\n'
      writeFileSync(configPath(), initial)
      const unrelated = join(dir, 'unrelated.toml')
      writeFileSync(unrelated, 'preserve = true\n')
      symlinkSync(unrelated, `${configPath()}.bak`)

      expect(() => new KimiHookService().install()).toThrow(
        'Refusing to overwrite symlinked backup'
      )
      expect(readFileSync(configPath(), 'utf-8')).toBe(initial)
      expect(readFileSync(unrelated, 'utf-8')).toBe('preserve = true\n')
      expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([])
    }
  )

  it.skipIf(!supportsPosixFileModes)('keeps a symlinked config.toml and updates its target', () => {
    const dir = join(home, '.kimi-code')
    mkdirSync(dir, { recursive: true })
    const target = join(home, 'dotfiles-kimi-config.toml')
    const initial = 'model = "kimi-k2"\n'
    writeFileSync(target, initial, { mode: 0o600 })
    symlinkSync(target, configPath())

    expect(new KimiHookService().install().state).toBe('installed')
    expect(lstatSync(configPath()).isSymbolicLink()).toBe(true)
    expect(readFileSync(`${target}.bak`, 'utf-8')).toBe(initial)
    expect(readFileSync(target, 'utf-8')).toContain('kimi-hook')
  })

  it.skipIf(process.platform !== 'win32')(
    'keeps config.toml.bak writable on Windows so a read-only config cannot wedge later writes',
    () => {
      const dir = join(home, '.kimi-code')
      mkdirSync(dir, { recursive: true })
      writeFileSync(configPath(), 'model = "first"\n')
      chmodSync(configPath(), 0o444)

      const service = new KimiHookService()
      expect(() => service.install()).toThrow()
      expect(statSync(`${configPath()}.bak`).mode & 0o200).toBe(0o200)
      expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([])

      chmodSync(configPath(), 0o666)
      writeFileSync(configPath(), 'model = "second"\n')
      expect(service.install().state).toBe('installed')
      expect(readFileSync(`${configPath()}.bak`, 'utf-8')).toBe('model = "second"\n')
      expect(statSync(`${configPath()}.bak`).mode & 0o200).toBe(0o200)
    }
  )

  it.skipIf(process.platform !== 'win32')(
    'replaces a stale read-only config.toml.bak on Windows',
    () => {
      const dir = join(home, '.kimi-code')
      mkdirSync(dir, { recursive: true })
      writeFileSync(configPath(), 'model = "current"\n')
      writeFileSync(`${configPath()}.bak`, 'model = "stuck"\n')
      chmodSync(`${configPath()}.bak`, 0o444)

      expect(new KimiHookService().install().state).toBe('installed')
      expect(readFileSync(`${configPath()}.bak`, 'utf-8')).toBe('model = "current"\n')
      expect(statSync(`${configPath()}.bak`).mode & 0o200).toBe(0o200)
    }
  )
})
