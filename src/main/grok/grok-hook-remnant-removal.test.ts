import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SFTPWrapper } from 'ssh2'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { homedirMock } = vi.hoisted(() => ({ homedirMock: vi.fn<() => string>() }))
vi.mock('os', async () => {
  const actual = (await vi.importActual('os')) as Record<string, unknown>
  return { ...actual, homedir: homedirMock }
})

import { GrokHookService } from './hook-service'
import { createRemoteHookTestFilesystem } from '../agent-hooks/remote-hook-test-filesystem'

// Why one file covering all three removal paths: the local path was fixed for this and the remote
// path shipped with the identical bug, because nothing exercised the rule more than once. Removal
// used to unlink only when the WHOLE config object was empty, but it strips just the `hooks` key --
// so any other top-level key left a remnant, and the user-cleared install guard then read that
// remnant as a deliberate opt-out and never reinstalled. Silently. Forever.
const SCHEMA = 'https://grok.example/hooks.schema.json'

describe('Grok hook removal leaves no remnant that blocks reinstall', () => {
  let homeDir: string
  let configPath: string

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'orca-grok-remnant-'))
    homedirMock.mockReturnValue(homeDir)
    configPath = join(homeDir, '.grok', 'hooks', 'orca-status.json')
  })

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  function installThenAddSchema(service: GrokHookService): void {
    expect(service.install().state).toBe('installed')
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
    config.$schema = SCHEMA
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  }

  it('removes it on the sync path', () => {
    const service = new GrokHookService()
    installThenAddSchema(service)

    expect(service.remove().state).toBe('not_installed')

    expect(existsSync(configPath)).toBe(false)
    expect(service.install().state).toBe('installed')
  })

  it('removes it on the quit path', async () => {
    const service = new GrokHookService()
    installThenAddSchema(service)

    await service.removeAsync({ force: true })

    expect(existsSync(configPath)).toBe(false)
    expect(service.install().state).toBe('installed')
  })

  it('removes it on the remote path', async () => {
    const remoteConfig = '/home/dev/.grok/hooks/orca-status.json'
    const service = new GrokHookService()
    const { sftp, fs } = createRemoteHookTestFilesystem()
    const first = await service.installRemote(sftp, '/home/dev')
    expect(first.state).toBe('installed')
    const config = JSON.parse(fs.files.get(remoteConfig)!) as Record<string, unknown>
    config.$schema = SCHEMA
    fs.files.set(remoteConfig, `${JSON.stringify(config, null, 2)}\n`)

    await service.removeRemote(sftp as SFTPWrapper, '/home/dev')

    expect(fs.files.get(remoteConfig)).toBeUndefined()
    const reinstalled = await service.installRemote(sftp, '/home/dev')
    expect(reinstalled.state).toBe('installed')
  })
})
