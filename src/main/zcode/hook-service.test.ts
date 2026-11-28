import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type * as NodeOs from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { homedirMock } = vi.hoisted(() => ({ homedirMock: vi.fn<() => string>() }))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os')
  return { ...actual, homedir: homedirMock }
})

import { zcodeHookService } from './hook-service'
import { localDiskSftp } from '../agent-hooks/installation/remote/local-disk-sftp.test-fixture'

const EVENTS = [
  'PermissionRequest',
  'PostToolUse',
  'PostToolUseFailure',
  'PreToolUse',
  'SessionStart',
  'Stop',
  'UserPromptSubmit'
]

function managedEvents(path: string): string[] {
  const events = JSON.parse(readFileSync(path, 'utf-8')).hooks?.events ?? {}
  return Object.keys(events)
    .filter((event) => JSON.stringify(events[event]).includes('zcode-hook.'))
    .sort()
}

describe('ZCode managed hooks', () => {
  let home: string
  let cliDir: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'orca-zcode-hooks-'))
    cliDir = join(home, '.zcode', 'cli')
    mkdirSync(cliDir, { recursive: true })
    homedirMock.mockReturnValue(home)
    vi.stubEnv('ZCODE_CLI_SETTINGS_FILE', '')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(home, { recursive: true, force: true })
  })

  // npm zcode-app-cli reads only setting.json and creates it on first launch, so Orca must never create it.
  it('installs into an existing setting.json, locally and remotely, without creating one', async () => {
    const configPath = join(cliDir, 'config.json')
    const settingsPath = join(cliDir, 'setting.json')
    const userSettings = JSON.stringify({
      mcp: { servers: {} },
      hooks: { enabled: false, events: { Stop: [] } }
    })
    const keepsUserKeys = { mcp: { servers: {} }, hooks: { enabled: true } }
    writeFileSync(configPath, '{"theme":"dark"}\n')

    zcodeHookService.install()
    await zcodeHookService.installRemote(localDiskSftp(), home)
    expect(existsSync(settingsPath)).toBe(false)

    writeFileSync(settingsPath, userSettings)
    expect(zcodeHookService.getStatus().state).toBe('partial')
    expect(zcodeHookService.install().state).toBe('installed')
    expect(JSON.parse(readFileSync(settingsPath, 'utf-8'))).toMatchObject(keepsUserKeys)
    expect(managedEvents(settingsPath)).toEqual(EVENTS)
    expect(zcodeHookService.remove().state).toBe('not_installed')
    expect(managedEvents(settingsPath)).toEqual([])
    expect(managedEvents(configPath)).toEqual([])

    writeFileSync(settingsPath, userSettings)
    expect((await zcodeHookService.installRemote(localDiskSftp(), home)).state).toBe('installed')
    expect(JSON.parse(readFileSync(settingsPath, 'utf-8'))).toMatchObject(keepsUserKeys)
    expect(managedEvents(settingsPath)).toEqual(EVENTS)

    // A directory stands in for an unreadable setting.json on every platform; config.json still installs.
    rmSync(settingsPath)
    mkdirSync(settingsPath)
    rmSync(configPath)
    const settingsError = { state: 'error', configPath: settingsPath, managedHooksPresent: true }
    expect(zcodeHookService.install()).toMatchObject(settingsError)
    expect(managedEvents(configPath)).toEqual(EVENTS)
    rmSync(configPath)
    expect(await zcodeHookService.installRemote(localDiskSftp(), home)).toMatchObject(settingsError)
    expect(managedEvents(configPath)).toEqual(EVENTS)
  })
})
