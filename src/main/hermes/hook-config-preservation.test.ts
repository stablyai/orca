import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SFTPWrapper } from 'ssh2'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'

import {
  readTextFileRemote,
  writeTextFileRemoteAtomic
} from '../agent-hooks/installer-utils-remote'
import { HermesHookService } from './hook-service'

vi.mock('../agent-hooks/installer-utils-remote', () => ({
  readTextFileRemote: vi.fn(),
  writeTextFileRemoteAtomic: vi.fn()
}))

const original = [
  '# User model preferences',
  'model:',
  "    name: 'test-model' # Do not change",
  '    instructions: |-',
  '        Keep this text as written.',
  'plugins:',
  '    enabled: ["other-plugin"] # Keep this integration',
  '    settings: {other-plugin: {value: "yes"}}',
  ''
].join('\n')

describe('Hermes hook config persistence', () => {
  let homeDir: string
  let configPath: string

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'orca-hermes-config-'))
    configPath = join(homeDir, 'config.yaml')
    vi.stubEnv('HERMES_HOME', homeDir)
    vi.mocked(readTextFileRemote).mockReset()
    vi.mocked(writeTextFileRemoteAtomic).mockReset()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(homeDir, { recursive: true, force: true })
  })

  it('preserves user content through local install, reinstall and removal', () => {
    writeFileSync(configPath, original)
    const service = new HermesHookService()

    expect(service.install().state).toBe('installed')
    const installed = readFileSync(configPath, 'utf-8')
    expect(installed).toContain(original.slice(0, original.indexOf('plugins:')))
    expect(installed).toContain('# Keep this integration')
    expect(installed).toContain('    settings: {other-plugin: {value: "yes"}}')
    expect(readFileSync(`${configPath}.bak`, 'utf-8')).toBe(original)

    const installedStat = statSync(configPath)
    expect(service.install().state).toBe('installed')
    expect(readFileSync(configPath, 'utf-8')).toBe(installed)
    expect(statSync(configPath).ino).toBe(installedStat.ino)
    expect(statSync(configPath).mtimeMs).toBe(installedStat.mtimeMs)
    expect(readFileSync(`${configPath}.bak`, 'utf-8')).toBe(original)

    expect(service.remove().state).toBe('not_installed')
    const removed = readFileSync(configPath, 'utf-8')
    expect(removed).toContain(original.slice(0, original.indexOf('plugins:')))
    expect(removed).toContain('# Keep this integration')
    expect(removed).toContain('    settings: {other-plugin: {value: "yes"}}')
    expect(parse(removed)).toMatchObject({ plugins: { enabled: ['other-plugin'] } })
    expect(existsSync(join(homeDir, 'plugins', 'orca-status'))).toBe(false)
    const removedStat = statSync(configPath)
    expect(service.remove().state).toBe('not_installed')
    expect(readFileSync(configPath, 'utf-8')).toBe(removed)
    expect(statSync(configPath).ino).toBe(removedStat.ino)
  })

  it.each(['plugins: [unterminated', 'plugins: &plugins {enabled: []}\nother: *plugins\n'])(
    'does not create plugin files when config editing is rejected: %s',
    (content) => {
      writeFileSync(configPath, content)
      expect(new HermesHookService().install().state).toBe('error')
      expect(readFileSync(configPath, 'utf-8')).toBe(content)
      expect(existsSync(`${configPath}.bak`)).toBe(false)
      expect(existsSync(join(homeDir, 'plugins', 'orca-status'))).toBe(false)
    }
  )

  it('does not remove managed plugin files when config editing is rejected', () => {
    const service = new HermesHookService()
    expect(service.install().state).toBe('installed')
    const content = 'plugins: &plugins {enabled: [orca-status]}\nother: *plugins\n'
    writeFileSync(configPath, content)
    expect(service.remove().state).toBe('error')
    expect(readFileSync(configPath, 'utf-8')).toBe(content)
    expect(existsSync(join(homeDir, 'plugins', 'orca-status', '__init__.py'))).toBe(true)
  })

  it('sends preserved config text to the SSH writer without touching the local home', async () => {
    const files = new Map([['/home/remote/.hermes/config.yaml', original]])
    vi.mocked(readTextFileRemote).mockImplementation(async (_sftp, path) => files.get(path) ?? null)
    vi.mocked(writeTextFileRemoteAtomic).mockImplementation(async (_sftp, path, content) => {
      files.set(path, content)
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Mocked file boundaries never inspect the SFTP handle.
    const sftp = {} as SFTPWrapper

    expect((await new HermesHookService().installRemote(sftp, '/home/remote/')).state).toBe(
      'installed'
    )

    const installed = files.get('/home/remote/.hermes/config.yaml')
    expect(installed).toContain(original.slice(0, original.indexOf('plugins:')))
    expect(installed).toContain('# Keep this integration')
    expect(installed).toContain('    settings: {other-plugin: {value: "yes"}}')
    expect(parse(installed ?? '')).toMatchObject({
      plugins: { enabled: ['other-plugin', 'orca-status'] }
    })
    expect(existsSync(configPath)).toBe(false)
  })

  it('does not write remote plugin files or config when editing is rejected', async () => {
    vi.mocked(readTextFileRemote).mockResolvedValue('plugins: [unterminated')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Mocked file boundaries never inspect the SFTP handle.
    const sftp = {} as SFTPWrapper
    expect((await new HermesHookService().installRemote(sftp, '/home/remote')).state).toBe('error')
    expect(writeTextFileRemoteAtomic).not.toHaveBeenCalled()
  })
})
