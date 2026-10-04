import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import { HermesHookService } from './hook-service'

const configured =
  '# Operator comments\r\nmodel: "fixture"\r\nplugins:\r\n  enabled: [orca-status]\r\n'
const initial =
  '# Recovery notes\nmodel: "001"\nprompt: |\n  First\n  Second\nplugins:\n  enabled: [other] # choices\n'

describe('Hermes config preservation on disk', () => {
  let directory: string
  let configPath: string
  const service = new HermesHookService()

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'orca-hermes-config-'))
    configPath = join(directory, 'config.yaml')
    vi.stubEnv('HERMES_HOME', directory)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(directory, { recursive: true, force: true })
  })

  it('leaves unchanged bytes, inode, timestamp, mode and backup untouched', () => {
    writeFileSync(configPath, configured, { mode: 0o600 })
    writeFileSync(`${configPath}.bak`, 'previous recovery point', { mode: 0o600 })
    utimesSync(configPath, 1_600_000_000, 1_600_000_000)
    const before = statSync(configPath)
    const backup = statSync(`${configPath}.bak`)
    expect(service.install().state).toBe('installed')
    expect(readFileSync(configPath, 'utf8')).toBe(configured)
    const after = statSync(configPath)
    expect([after.ino, after.mtimeMs, after.mode]).toEqual([
      before.ino,
      before.mtimeMs,
      before.mode
    ])
    expect(statSync(`${configPath}.bak`)).toEqual(backup)
    expect(readFileSync(`${configPath}.bak`, 'utf8')).toBe('previous recovery point')
  })

  it('does not create a backup on a no-op', () => {
    writeFileSync(configPath, configured)
    service.install()
    expect(existsSync(`${configPath}.bak`)).toBe(false)
  })

  it('does not create a config when removing an absent integration', () => {
    expect(service.remove().state).toBe('not_installed')
    expect(readdirSync(directory)).toEqual([])
  })

  it('preserves comments and multiline values through real install and removal', () => {
    writeFileSync(configPath, initial)
    expect(service.install().state).toBe('installed')
    const installed = readFileSync(configPath, 'utf8')
    expect(parse(installed).plugins.enabled).toEqual(['other', 'orca-status'])
    expect(readFileSync(`${configPath}.bak`, 'utf8')).toBe(initial)
    expect(service.remove().state).toBe('not_installed')
    const removed = readFileSync(configPath, 'utf8')
    for (const output of [installed, removed]) {
      expect(output).toContain('# Recovery notes')
      expect(output).toContain('# choices')
      expect(output).toContain('model: "001"')
      expect(output).toContain('prompt: |\n  First\n  Second\n')
    }
    expect(parse(removed)).toEqual(parse(initial))
    expect(readFileSync(`${configPath}.bak`, 'utf8')).toBe(installed)
  })

  it.skipIf(process.platform === 'win32').each([
    [0o600, 0o022],
    [0o600, 0],
    [0o640, 0o077],
    [0o640, 0]
  ])('preserves mode %i with umask %i and a byte-exact backup', (mode, mask) => {
    writeFileSync(configPath, initial)
    chmodSync(configPath, mode)
    const previous = process.umask(mask)
    try {
      expect(service.install().state).toBe('installed')
    } finally {
      process.umask(previous)
    }
    expect(statSync(configPath).mode & 0o777).toBe(mode)
    expect(statSync(`${configPath}.bak`).mode & 0o777).toBe(mode)
    expect(readFileSync(`${configPath}.bak`, 'utf8')).toBe(initial)
    expect(readdirSync(directory).sort()).toEqual(['config.yaml', 'config.yaml.bak', 'plugins'])
  })

  it.skipIf(process.platform === 'win32')(
    'creates a private new config with permissive umask',
    () => {
      const previous = process.umask(0)
      try {
        expect(service.install().state).toBe('installed')
      } finally {
        process.umask(previous)
      }
      expect(statSync(configPath).mode & 0o777).toBe(0o600)
      expect(existsSync(`${configPath}.bak`)).toBe(false)
    }
  )

  it.skipIf(process.platform === 'win32')('keeps the config symlink and updates its target', () => {
    const target = join(directory, 'dotfiles.yaml')
    writeFileSync(target, initial, { mode: 0o600 })
    symlinkSync(target, configPath)
    expect(service.install().state).toBe('installed')
    expect(lstatSync(configPath).isSymbolicLink()).toBe(true)
    expect(parse(readFileSync(target, 'utf8')).plugins.enabled).toContain('orca-status')
    expect(readFileSync(`${target}.bak`, 'utf8')).toBe(initial)
  })

  it.skipIf(process.platform === 'win32')('refuses a dangling config symlink', () => {
    symlinkSync(join(directory, 'missing.yaml'), configPath)
    expect(() => service.install()).toThrow()
    expect(lstatSync(configPath).isSymbolicLink()).toBe(true)
    expect(readdirSync(directory)).toEqual(['config.yaml'])
  })

  it.skipIf(process.platform === 'win32')(
    'refuses a symlinked backup without touching its target',
    () => {
      writeFileSync(configPath, initial)
      const target = join(directory, 'unrelated')
      writeFileSync(target, 'preserve me')
      symlinkSync(target, `${configPath}.bak`)
      expect(() => service.install()).toThrow('Refusing to overwrite symlinked backup')
      expect(readFileSync(configPath, 'utf8')).toBe(initial)
      expect(readFileSync(target, 'utf8')).toBe('preserve me')
      expect(readdirSync(directory).some((name) => name.endsWith('.tmp'))).toBe(false)
    }
  )

  it('replaces a hard-linked backup without changing the unrelated inode', () => {
    writeFileSync(configPath, initial)
    const target = join(directory, 'unrelated')
    writeFileSync(target, 'preserve me')
    linkSync(target, `${configPath}.bak`)
    expect(service.install().state).toBe('installed')
    expect(readFileSync(target, 'utf8')).toBe('preserve me')
    expect(readFileSync(`${configPath}.bak`, 'utf8')).toBe(initial)
  })

  it('keeps the config and cleans temporary files when backup publication fails', () => {
    writeFileSync(configPath, initial)
    mkdirSync(`${configPath}.bak`)
    expect(() => service.install()).toThrow()
    expect(readFileSync(configPath, 'utf8')).toBe(initial)
    expect(readdirSync(directory).some((name) => name.endsWith('.tmp'))).toBe(false)
  })

  it('keeps installed plugin files if removal cannot back up the config', () => {
    expect(service.install().state).toBe('installed')
    const before = readFileSync(configPath, 'utf8')
    mkdirSync(`${configPath}.bak`)
    expect(() => service.remove()).toThrow()
    expect(readFileSync(configPath, 'utf8')).toBe(before)
    expect(existsSync(join(directory, 'plugins', 'orca-status', '__init__.py'))).toBe(true)
    expect(readdirSync(directory).some((name) => name.endsWith('.tmp'))).toBe(false)
  })

  it('refuses alias-bearing removal before deleting installed plugin files', () => {
    expect(service.install().state).toBe('installed')
    const input = 'plugins:\n  enabled: &enabled [orca-status, other]\ncopy: *enabled\n'
    writeFileSync(configPath, input)
    expect(service.remove().state).toBe('error')
    expect(readFileSync(configPath, 'utf8')).toBe(input)
    expect(existsSync(join(directory, 'plugins', 'orca-status', '__init__.py'))).toBe(true)
    expect(existsSync(`${configPath}.bak`)).toBe(false)
  })

  it.each(['plugins: [', 'plugins: unexpected\n', 'plugins:\n  enabled: not-a-list\n'])(
    'does not install files or rewrite unexpected YAML (%s)',
    (input) => {
      writeFileSync(configPath, input)
      expect(service.install().state).toBe('error')
      expect(readFileSync(configPath, 'utf8')).toBe(input)
      expect(readdirSync(directory)).toEqual(['config.yaml'])
    }
  )
})
