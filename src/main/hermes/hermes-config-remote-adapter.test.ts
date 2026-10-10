import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { createManagedHookLocalFilesystem } from '../agent-hooks/managed-hook-local-filesystem'
import { HermesHookService } from './hook-service'

describe('Hermes remote installer through a local filesystem adapter (no SSH)', () => {
  let directory: string
  let configPath: string
  const service = new HermesHookService()

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'orca-hermes-remote-adapter-'))
    mkdirSync(join(directory, '.hermes'))
    configPath = join(directory, '.hermes', 'config.yaml')
  })
  afterEach(() => rmSync(directory, { recursive: true, force: true }))

  it('does not rewrite a configured CRLF file or an existing backup', async () => {
    const initial = '# operator notes\r\nplugins:\r\n  enabled: [zeta, orca-status, alpha]\r\n'
    writeFileSync(configPath, initial)
    writeFileSync(`${configPath}.bak`, 'recovery point')
    const before = statSync(configPath)
    expect((await service.installRemote(createManagedHookLocalFilesystem(), directory)).state).toBe(
      'installed'
    )
    expect(readFileSync(configPath, 'utf8')).toBe(initial)
    const after = statSync(configPath)
    expect([after.ino, after.mtimeMs, after.mode]).toEqual([
      before.ino,
      before.mtimeMs,
      before.mode
    ])
    expect(readFileSync(`${configPath}.bak`, 'utf8')).toBe('recovery point')
  })

  it.each(['\n', '\r\n'])(
    'preserves comments and parsed values during real install (%j)',
    async (eol) => {
      const input =
        '# notes\nmodel: "001"\nprompt: |\n  First\n  Second\nplugins:\n  enabled: [other]\n'.replaceAll(
          '\n',
          eol
        )
      writeFileSync(configPath, input)
      const filesystem = createManagedHookLocalFilesystem()
      expect((await service.installRemote(filesystem, directory)).state).toBe('installed')
      const installed = readFileSync(configPath, 'utf8')
      expect(installed).toContain('# notes')
      expect(installed).toContain(`prompt: |${eol}  First${eol}  Second`)
      expect(parse(installed)).toEqual({
        ...parse(input),
        plugins: { enabled: ['other', 'orca-status'] }
      })
      const before = statSync(configPath)
      expect((await service.installRemote(filesystem, directory)).state).toBe('installed')
      expect(statSync(configPath).ino).toBe(before.ino)
      expect(existsSync(`${configPath}.bak`)).toBe(false)
    }
  )

  it.skipIf(process.platform === 'win32').each([0o600, 0o640])(
    'preserves mode %i despite umask',
    async (mode) => {
      writeFileSync(configPath, 'model: fixture\n')
      chmodSync(configPath, mode)
      const previous = process.umask(0o077)
      try {
        expect(
          (await service.installRemote(createManagedHookLocalFilesystem(), directory)).state
        ).toBe('installed')
      } finally {
        process.umask(previous)
      }
      expect(statSync(configPath).mode & 0o777).toBe(mode)
    }
  )

  it.each(['plugins: [', 'plugins: unexpected\n', 'plugins:\n  enabled: [123]\n'])(
    'refuses unsafe YAML before writing plugin files (%s)',
    async (input) => {
      writeFileSync(configPath, input)
      expect(
        (await service.installRemote(createManagedHookLocalFilesystem(), directory)).state
      ).toBe('error')
      expect(readFileSync(configPath, 'utf8')).toBe(input)
      expect(readdirSync(join(directory, '.hermes'))).toEqual(['config.yaml'])
    }
  )

  it('keeps the config and cleans staged files when remote rename fails', async () => {
    writeFileSync(configPath, 'model: fixture\n')
    const filesystem = createManagedHookLocalFilesystem()
    const rename = filesystem.ext_openssh_rename.bind(filesystem)
    filesystem.ext_openssh_rename = (source, destination, callback) => {
      if (destination === configPath) {
        callback(new Error('fixture rename refusal'))
      } else {
        rename(source, destination, callback)
      }
    }
    expect((await service.installRemote(filesystem, directory)).state).toBe('error')
    expect(readFileSync(configPath, 'utf8')).toBe('model: fixture\n')
    expect(readdirSync(join(directory, '.hermes')).sort()).toEqual(['config.yaml', 'plugins'])
  })
})
