import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KiroHookService } from './hook-service'

// Why: the service reads/writes homedir()/.kiro/settings/cli.json and its
// backup under homedir()/.orca. Point HOME at a temp dir so the local
// install/remove cycle never touches the real ~/.kiro or ~/.orca.
// os.homedir() resolves $HOME on POSIX (verified at write time).
let home: string
let originalHome: string | undefined

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orca-kiro-hook-'))
  originalHome = process.env.HOME
  process.env.HOME = home
})

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.HOME
  } else {
    process.env.HOME = originalHome
  }
  rmSync(home, { recursive: true, force: true })
})

const settingsPath = (): string => join(home, '.kiro', 'settings', 'cli.json')
const backupPath = (): string => join(home, '.orca', 'agent-hooks', 'kiro-settings-backup.json')

const readSettings = (): Record<string, unknown> =>
  JSON.parse(readFileSync(settingsPath(), 'utf-8'))

describe('KiroHookService', () => {
  it('reports not_installed before install', () => {
    expect(new KiroHookService().getStatus().state).toBe('not_installed')
  })

  it('enables Kiro native notification settings on install', () => {
    const status = new KiroHookService().install()
    expect(status.state).toBe('installed')
    expect(status.managedHooksPresent).toBe(true)

    const settings = readSettings()
    expect(settings['chat.enableNotifications']).toBe(true)
    expect(settings['chat.notificationMethod']).toBe('bell')
    expect(settings['chat.terminalTitle']).toBe(true)
  })

  it('keeps unrelated user settings when installing', () => {
    mkdirSync(join(home, '.kiro', 'settings'), { recursive: true })
    writeFileSync(
      settingsPath(),
      JSON.stringify({ 'chat.defaultModel': 'my-model', 'mcp.loadedBefore': true })
    )

    const service = new KiroHookService()
    expect(service.install().state).toBe('installed')

    const settings = readSettings()
    expect(settings['chat.defaultModel']).toBe('my-model')
    expect(settings['mcp.loadedBefore']).toBe(true)
  })

  it('restores prior values on remove, deleting keys that did not exist', () => {
    mkdirSync(join(home, '.kiro', 'settings'), { recursive: true })
    // User had notifications explicitly off but terminal titles on.
    writeFileSync(
      settingsPath(),
      JSON.stringify({ 'chat.enableNotifications': false, 'chat.terminalTitle': true })
    )

    const service = new KiroHookService()
    expect(service.install().state).toBe('installed')

    const removed = service.remove()
    expect(removed.state).toBe('not_installed')

    const settings = readSettings()
    expect(settings['chat.enableNotifications']).toBe(false)
    // chat.terminalTitle already had the managed value before install; the
    // backup records the user's value, so remove() restores it instead of
    // deleting a setting the user chose themselves.
    expect(settings['chat.terminalTitle']).toBe(true)
    expect(settings['chat.notificationMethod']).toBeUndefined()
    expect(existsSync(backupPath())).toBe(false)
  })

  it('does not overwrite the first backup on re-install', () => {
    const service = new KiroHookService()
    service.install()
    // Simulate a later re-install after the managed values are already live.
    service.install()

    const removed = service.remove()
    expect(removed.state).toBe('not_installed')
    const settings = readSettings()
    // All three keys were absent originally, so remove() deletes them.
    expect('chat.enableNotifications' in settings).toBe(false)
    expect('chat.notificationMethod' in settings).toBe(false)
    expect('chat.terminalTitle' in settings).toBe(false)
  })

  it('leaves keys the user changed away from managed values alone on remove', () => {
    const service = new KiroHookService()
    service.install()
    // User later switches the notification method to their own preference.
    const settings = readSettings()
    settings['chat.notificationMethod'] = 'osc9'
    writeFileSync(settingsPath(), JSON.stringify(settings))

    service.remove()
    const after = readSettings()
    expect(after['chat.notificationMethod']).toBe('osc9')
    expect('chat.enableNotifications' in after).toBe(false)
  })

  it('reports error on an unparseable cli.json without writing to it', () => {
    mkdirSync(join(home, '.kiro', 'settings'), { recursive: true })
    writeFileSync(settingsPath(), '{not json')

    const service = new KiroHookService()
    expect(service.getStatus().state).toBe('error')
    expect(service.install().state).toBe('error')
    expect(readFileSync(settingsPath(), 'utf-8')).toBe('{not json')
  })
})
