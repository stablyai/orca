import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseMuseSettingsText } from './hook-config-json'
import { MuseHookService } from './hook-service'
import { MUSE_HOOK_EVENTS, buildMuseManagedHooksFile, getMuseManagedCommand } from './hook-settings'
import { wrapWindowsHookCommand } from '../agent-hooks/windows-hook-command'
import { createAgentHookMemorySftp } from '../agent-hooks/agent-hook-memory-sftp.test-fixture'

// Why: getSharedManagedScriptPath() writes under homedir()/.orca and the
// Muse config resolves via XDG_CONFIG_HOME ?? ~/.config/muse. Point HOME
// at a temp dir and clear XDG_CONFIG_HOME so install/remove never touches the
// real ~/.orca or ~/.config/muse. os.homedir() resolves $HOME on POSIX.
let home: string
let originalHome: string | undefined
let originalXdg: string | undefined
let originalProfile: string | undefined

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orca-muse-hook-'))
  originalProfile = process.env.USERPROFILE
  process.env.USERPROFILE = home
  originalHome = process.env.HOME
  originalXdg = process.env.XDG_CONFIG_HOME
  process.env.HOME = home
  delete process.env.XDG_CONFIG_HOME
})

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.HOME
  } else {
    process.env.HOME = originalHome
  }
  if (originalXdg === undefined) {
    delete process.env.XDG_CONFIG_HOME
  } else {
    process.env.XDG_CONFIG_HOME = originalXdg
  }
  if (originalProfile === undefined) {
    delete process.env.USERPROFILE
  } else {
    process.env.USERPROFILE = originalProfile
  }
  vi.restoreAllMocks()
  rmSync(home, { recursive: true, force: true })
})

const configPath = (): string => join(home, '.config', 'muse', 'settings.json')
const managedHooksPath = (): string => join(home, '.orca', 'agent-hooks', 'muse-hooks.json')
const scriptPath = (): string =>
  join(
    home,
    '.orca',
    'agent-hooks',
    process.platform === 'win32' ? 'muse-hook.cmd' : 'muse-hook.sh'
  )

describe('MuseHookService', () => {
  it('reports not_installed before install', () => {
    expect(new MuseHookService().getStatus().state).toBe('not_installed')
  })

  it('installs the managed hooks pointer, file, and script', () => {
    const status = new MuseHookService().install()
    expect(status.state).toBe('installed')
    expect(status.managedHooksPresent).toBe(true)

    // The settings pointer aims at the Orca-owned managed file, and a fresh
    // settings.json carries the schema_version muse requires.
    const settings = parseMuseSettingsText(readFileSync(configPath(), 'utf-8'), 'test')
    expect(settings?.managed_hooks_path).toBe(managedHooksPath())
    expect(settings?.schema_version).toBe(1)
    expect(settings?.managed_hooks_env_vars).toContain('ORCA_PANE_KEY')

    const managedText = readFileSync(managedHooksPath(), 'utf-8')
    expect(managedText).toContain(process.platform === 'win32' ? 'muse-hook.cmd' : 'muse-hook.sh')
    expect(MUSE_HOOK_EVENTS.every((event) => managedText.includes(`"${event}"`))).toBe(true)
    // The managed script must exist and POST to the muse hook endpoint.
    const script = readFileSync(scriptPath(), 'utf-8')
    expect(script).toContain('/hook/muse')
    // Why: payload is piped to curl via stdin so it never lands on the curl
    // command line (EDR oversized-command-line false positive).
    expect(script).toContain(
      process.platform === 'win32' ? 'payload@-' : 'printf \'%s\' "$payload" | curl'
    )
  })

  it('keeps user settings when installing, then drops only the pointer on remove', () => {
    mkdirSync(join(home, '.config', 'muse'), { recursive: true })
    const userSettings = `{\n  "schema_version": 1,\n  "model": "muse-spark-1.2",\n  "approval_mode": "never"\n}\n`
    writeFileSync(configPath(), userSettings)

    const service = new MuseHookService()
    expect(service.install().state).toBe('installed')

    const installed = readFileSync(configPath(), 'utf-8')
    expect(installed).toContain('"model": "muse-spark-1.2"')
    expect(installed).toContain('"approval_mode": "never"')

    // Reinstall must converge without duplicating the pointer.
    service.install()
    const reinstalled = readFileSync(configPath(), 'utf-8')
    expect((reinstalled.match(/managed_hooks_path/g) ?? []).length).toBe(1)

    const removed = service.remove()
    expect(removed.state).toBe('not_installed')
    const afterRemove = parseMuseSettingsText(readFileSync(configPath(), 'utf-8'), 'test')
    expect(afterRemove?.managed_hooks_path).toBeUndefined()
    expect(afterRemove?.model).toBe('muse-spark-1.2')
  })

  it('reports not_installed when the pointer aims elsewhere', () => {
    mkdirSync(join(home, '.config', 'muse'), { recursive: true })
    writeFileSync(
      configPath(),
      JSON.stringify({ schema_version: 1, managed_hooks_path: '/central/hooks.json' })
    )
    const status = new MuseHookService().getStatus()
    expect(status.state).toBe('not_installed')
    expect(status.detail).toContain('/central/hooks.json')
  })

  it('does not overwrite a user-managed hooks pointer during install', () => {
    mkdirSync(join(home, '.config', 'muse'), { recursive: true })
    const userPath = '/user-owned/muse-hooks.json'
    writeFileSync(configPath(), JSON.stringify({ schema_version: 1, managed_hooks_path: userPath }))
    const status = new MuseHookService().install()
    expect(status.state).toBe('not_installed')
    expect(status.detail).toContain(userPath)
    expect(
      parseMuseSettingsText(readFileSync(configPath(), 'utf-8'), 'test')?.managed_hooks_path
    ).toBe(userPath)
  })

  it('treats malformed managed hook entries as absent instead of throwing', () => {
    mkdirSync(join(home, '.config', 'muse'), { recursive: true })
    mkdirSync(join(home, '.orca', 'agent-hooks'), { recursive: true })
    const managedPath = join(home, '.orca', 'agent-hooks', 'muse-hooks.json')
    writeFileSync(configPath(), JSON.stringify({ schema_version: 1 }))
    const service = new MuseHookService()
    expect(service.install().state).toBe('installed')
    // Hand-edited damage: null definition, non-array hooks, null entry,
    // non-string command — status must degrade, never throw.
    const damaged = parseMuseSettingsText(readFileSync(managedPath, 'utf-8'), 'test')
    expect(damaged).not.toBeNull()
    if (!damaged) {
      throw new Error('expected generated Muse hooks')
    }
    damaged.hooks = {
      ...(typeof damaged.hooks === 'object' && damaged.hooks !== null ? damaged.hooks : {}),
      UserPromptSubmit: [null, { hooks: 'not-an-array' }, { hooks: [null, { command: 42 }] }]
    }
    writeFileSync(managedPath, JSON.stringify(damaged))
    expect(() => service.getStatus()).not.toThrow()
    expect(service.getStatus().state).toBe('partial')
  })

  it.skipIf(process.platform !== 'win32')(
    'upgrades encoded registrations once during refresh',
    async () => {
      const service = new MuseHookService()
      service.install()
      const settings = readFileSync(configPath(), 'utf8')
      writeFileSync(
        managedHooksPath(),
        buildMuseManagedHooksFile(wrapWindowsHookCommand(scriptPath()))
      )
      await service.refreshManagedScripts()
      const upgraded = readFileSync(managedHooksPath(), 'utf8')
      expect(upgraded).toBe(buildMuseManagedHooksFile(getMuseManagedCommand(scriptPath())))
      expect(upgraded).toContain(getMuseManagedCommand(scriptPath()))
      const modified = statSync(managedHooksPath()).mtimeMs
      await service.refreshManagedScripts()
      expect(readFileSync(managedHooksPath(), 'utf8')).toBe(upgraded)
      expect(statSync(managedHooksPath()).mtimeMs).toBe(modified)
      expect(readFileSync(configPath(), 'utf8')).toBe(settings)
      expect(service.getStatus().state).toBe('installed')
    }
  )

  it('refresh never registers absent hooks or replaces a user-owned pointer', async () => {
    const service = new MuseHookService()
    await service.refreshManagedScripts()
    expect(service.getStatus().state).toBe('not_installed')
    service.install()
    const managed = readFileSync(managedHooksPath(), 'utf8')
    writeFileSync(configPath(), JSON.stringify({ managed_hooks_path: '/user/hooks.json' }))
    await service.refreshManagedScripts()
    expect(readFileSync(managedHooksPath(), 'utf8')).toBe(managed)
    expect(
      parseMuseSettingsText(readFileSync(configPath(), 'utf8'), 'test')?.managed_hooks_path
    ).toBe('/user/hooks.json')
  })

  it('installs POSIX hooks on the SSH host even from a Windows client', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const remote = createAgentHookMemorySftp()
    const service = new MuseHookService()
    expect((await service.installRemote(remote.sftp, '/home/alice smith')).state).toBe('installed')
    const remoteHooksPath = '/home/alice smith/.orca/agent-hooks/muse-hooks.json'
    const installed = remote.fs.files.get(remoteHooksPath)
    expect(installed).toContain('/home/alice smith/.orca/agent-hooks/muse-hook.sh')
    expect(installed).not.toMatch(/powershell|EncodedCommand|muse-hook.cmd/)
    expect(remote.fs.files.get('/home/alice smith/.orca/agent-hooks/muse-hook.sh')).toContain(
      '#!/bin/sh'
    )
    await service.installRemote(remote.sftp, '/home/alice smith')
    expect(remote.fs.files.get(remoteHooksPath)).toBe(installed)
  })
})
