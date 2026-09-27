import {
  chmodSync,
  existsSync,
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
import { parse } from 'yaml'

import { createManagedHookLocalFilesystem } from '../agent-hooks/managed-hook-local-filesystem'
import { disablePlugin, enablePlugin, updateConfigContent } from './hermes-config-yaml'
import { writeConfigFile } from './hermes-home-filesystem'
import { HermesHookService } from './hook-service'

const configured =
  '# Keep operator comments\r\nmodel: "fixture"\r\nplugins:\r\n  enabled: [orca-status]\r\n'

describe('Hermes config preservation', () => {
  let directory: string
  let configPath: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'orca-hermes-config-'))
    configPath = join(directory, 'config.yaml')
  })

  afterEach(() => rmSync(directory, { recursive: true, force: true }))

  it('leaves configured YAML bytes, inode, timestamp and previous backup untouched', () => {
    writeFileSync(configPath, configured, { mode: 0o600 })
    writeFileSync(`${configPath}.bak`, 'previous recovery point', { mode: 0o600 })
    const before = statSync(configPath)
    writeConfigFile(configPath, enablePlugin(parse(configured)))
    expect(readFileSync(configPath, 'utf8')).toBe(configured)
    expect(statSync(configPath).ino).toBe(before.ino)
    expect(statSync(configPath).mtimeMs).toBe(before.mtimeMs)
    expect(statSync(configPath).mode).toBe(before.mode)
    expect(readFileSync(`${configPath}.bak`, 'utf8')).toBe('previous recovery point')
  })

  it('does not create a backup for an unchanged config', () => {
    writeFileSync(configPath, configured, { mode: 0o600 })
    writeConfigFile(configPath, enablePlugin(parse(configured)))
    expect(existsSync(`${configPath}.bak`)).toBe(false)
  })

  it.skipIf(process.platform === 'win32')(
    'creates new config privately even with permissive umask',
    () => {
      const previous = process.umask(0)
      try {
        writeConfigFile(configPath, enablePlugin({}))
      } finally {
        process.umask(previous)
      }
      expect(statSync(configPath).mode & 0o777).toBe(0o600)
      expect(parse(readFileSync(configPath, 'utf8')).plugins.enabled).toEqual(['orca-status'])
    }
  )

  it.skipIf(process.platform === 'win32').each([0o600, 0o640])(
    'preserves existing mode %i during a real change',
    (mode) => {
      const initial = '# recovery\nmodel: fixture\nplugins:\n  enabled: [existing]\n'
      writeFileSync(configPath, initial)
      chmodSync(configPath, mode)
      const previous = process.umask(mode === 0o600 ? 0o022 : 0o077)
      try {
        writeConfigFile(configPath, enablePlugin(parse(initial)))
      } finally {
        process.umask(previous)
      }
      expect(statSync(configPath).mode & 0o777).toBe(mode)
      expect(readFileSync(`${configPath}.bak`, 'utf8')).toBe(initial)
      expect(statSync(`${configPath}.bak`).mode & 0o777).toBe(mode)
      expect(parse(readFileSync(configPath, 'utf8')).plugins.enabled).toEqual([
        'existing',
        'orca-status'
      ])
      expect(readdirSync(directory).sort()).toEqual(['config.yaml', 'config.yaml.bak'])
    }
  )

  it('preserves SSH content verbatim when plugin configuration already matches', () => {
    expect(updateConfigContent(configured, enablePlugin)).toEqual({ content: configured })
  })

  it('keeps config inode and bytes across repeated remote installer calls', async () => {
    const service = new HermesHookService()
    const filesystem = createManagedHookLocalFilesystem()
    expect((await service.installRemote(filesystem, directory)).state).toBe('installed')
    const remoteConfig = join(directory, '.hermes', 'config.yaml')
    writeFileSync(remoteConfig, configured)
    const before = statSync(remoteConfig)
    expect((await service.installRemote(filesystem, directory)).state).toBe('installed')
    expect(readFileSync(remoteConfig, 'utf8')).toBe(configured)
    expect(statSync(remoteConfig).ino).toBe(before.ino)
    expect(statSync(remoteConfig).mode).toBe(before.mode)
    expect(statSync(remoteConfig).mtimeMs).toBe(before.mtimeMs)
    expect(
      readFileSync(join(directory, '.hermes', 'plugins', 'orca-status', 'plugin.yaml'), 'utf8')
    ).toContain('provides_hooks:')
  })

  it.skipIf(process.platform === 'win32')(
    'refuses a symlinked backup without changing config or backup target',
    () => {
      writeFileSync(configPath, 'model: fixture\n', { mode: 0o600 })
      const target = join(directory, 'unrelated')
      writeFileSync(target, 'preserve me')
      symlinkSync(target, `${configPath}.bak`)
      expect(() => writeConfigFile(configPath, enablePlugin({ model: 'fixture' }))).toThrow(
        'Refusing to overwrite symlinked backup'
      )
      expect(readFileSync(configPath, 'utf8')).toBe('model: fixture\n')
      expect(readFileSync(target, 'utf8')).toBe('preserve me')
      expect(readdirSync(directory).sort()).toEqual(['config.yaml', 'config.yaml.bak', 'unrelated'])
    }
  )

  it('still enables and removes plugin configuration for remote writes', () => {
    const enabled = updateConfigContent('model: fixture\n', enablePlugin)
    expect(parse(enabled.content!).plugins.enabled).toEqual(['orca-status'])
    const disabled = updateConfigContent(enabled.content, disablePlugin)
    expect(parse(disabled.content!).plugins.enabled).toEqual([])
    expect(parse(disabled.content!).model).toBe('fixture')
  })

  it('does not treat malformed remote YAML as an unchanged config', () => {
    const result = updateConfigContent('plugins: [', enablePlugin)
    expect(result.content).toBeNull()
    expect(result.detail).toBeTruthy()
  })
})
