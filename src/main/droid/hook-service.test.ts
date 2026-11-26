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

import { isPlainObject } from '../agent-hooks/installation/configuration/hooks-json-read'
import { createManagedCommandMatcher } from '../agent-hooks/installation/commands/managed-hook-command-matching'
import { wrapPosixHookCommand } from '../agent-hooks/installation/commands/posix-hook-command'
import { wrapRuntimeHomeHookCommand } from '../agent-hooks/installation/commands/runtime-home-hook-command'
import { wrapWindowsHookCommand } from '../agent-hooks/installation/commands/windows-hook-command'
import { droidHookService } from './hook-service'
import { localDiskSftp } from '../agent-hooks/installation/remote/local-disk-sftp.test-fixture'

const EVENTS = [
  'Notification',
  'PostToolUse',
  'PreToolUse',
  'SessionStart',
  'Stop',
  'SubagentStop',
  'UserPromptSubmit'
]
const USER_STOP = [{ hooks: [{ type: 'command', command: 'say done' }] }]
const USER_GUARD = [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard-rm' }] }]

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf-8'))
}

function managedEvents(events: unknown): string[] {
  return Object.entries(isPlainObject(events) ? events : {})
    .filter(([, definitions]) => JSON.stringify(definitions).includes('droid-hook.'))
    .map(([event]) => event)
    .sort()
}

describe('Droid managed hooks', () => {
  let home: string
  let factoryDir: string
  let hooksPath: string
  let settingsPath: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'orca-droid-hooks-'))
    factoryDir = join(home, '.factory')
    hooksPath = join(factoryDir, 'hooks.json')
    settingsPath = join(factoryDir, 'settings.json')
    mkdirSync(factoryDir, { recursive: true })
    homedirMock.mockReturnValue(home)
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  // Droid's merge: each hooks.json event replaces the same settings.json event.
  function effectiveHooks(hooksFile = hooksPath): Record<string, unknown> {
    const hooks = existsSync(hooksFile) ? readJson(hooksFile) : {}
    return Object.assign({}, readJson(settingsPath).hooks, hooks)
  }

  it.each(['local', 'remote'] as const)(
    'adds %s managed hooks to hooks.json only for events it defines',
    async (target) => {
      const staleOrca = {
        hooks: [{ type: 'command', command: '/old/.orca/agent-hooks/droid-hook.sh' }]
      }
      const settingsHooks = { Stop: [...USER_STOP, staleOrca], PreToolUse: USER_GUARD }
      writeFileSync(settingsPath, JSON.stringify({ model: 'x', hooks: settingsHooks }))
      const hooksFile = { Stop: USER_STOP, showHookOutput: false }
      writeFileSync(hooksPath, JSON.stringify(hooksFile))
      expect(droidHookService.getStatus()).toMatchObject({ state: 'not_installed' })

      const status =
        target === 'local'
          ? droidHookService.install()
          : await droidHookService.installRemote(localDiskSftp(), home)

      expect(status).toMatchObject({ state: 'installed', configPath: settingsPath })
      expect(managedEvents(readJson(hooksPath))).toEqual(['Stop'])
      expect(managedEvents(effectiveHooks())).toEqual(EVENTS)
      // The user's settings.json PreToolUse guard must still run.
      expect(effectiveHooks()).toMatchObject({
        Stop: [USER_STOP[0], {}],
        PreToolUse: [USER_GUARD[0], {}]
      })
      // Uninstall must disclose hooks.json while it carries Orca's entries.
      expect(droidHookService.getStatus()).toMatchObject({
        state: 'installed',
        additionalConfigPaths: [hooksPath]
      })

      expect(droidHookService.remove()).toMatchObject({ state: 'not_installed' })
      expect(readJson(hooksPath)).toEqual(hooksFile)
      expect(readJson(settingsPath)).toEqual({
        model: 'x',
        hooks: { Stop: USER_STOP, PreToolUse: USER_GUARD }
      })
    }
  )

  it('keeps every hook in settings.json when hooks.json is absent', () => {
    writeFileSync(settingsPath, JSON.stringify({ hooks: { PreToolUse: USER_GUARD } }))

    expect(droidHookService.install()).toMatchObject({ state: 'installed' })
    expect(existsSync(hooksPath)).toBe(false)
    expect(readJson(settingsPath).hooks).toMatchObject({ PreToolUse: [USER_GUARD[0], {}] })
    expect(managedEvents(effectiveHooks())).toEqual(EVENTS)
  })

  // A hooks.json `[]` hides that settings.json event, so uninstall must not drop it.
  it('keeps an empty hooks.json event the user wrote', () => {
    writeFileSync(settingsPath, JSON.stringify({ hooks: { Stop: USER_STOP } }))
    writeFileSync(hooksPath, JSON.stringify({ Stop: [] }))

    droidHookService.install()
    expect(managedEvents(readJson(hooksPath))).toEqual(['Stop'])
    droidHookService.remove()
    expect(readJson(hooksPath)).toEqual({ Stop: [] })
  })

  // Droid parses hooks.json as JSONC and ignores it on any parse error.
  it.each([
    {
      name: 'JSONC',
      text: '{ // audit\n "Stop": [] }',
      state: 'partial',
      detail: (path: string): string | null =>
        `Managed hook missing for events: Stop; ${path} has comments; Orca cannot edit it`
    },
    { name: 'malformed', text: '{ "Stop": [', state: 'installed', detail: () => null }
  ])('installs settings.json hooks beside a $name hooks.json', async ({ text, state, detail }) => {
    writeFileSync(settingsPath, JSON.stringify({ hooks: { Stop: USER_STOP } }))
    writeFileSync(hooksPath, text)

    expect(droidHookService.install()).toMatchObject({ state, detail: detail(hooksPath) })
    expect(await droidHookService.installRemote(localDiskSftp(), home)).toMatchObject({
      state,
      detail: detail(`${home}/.factory/hooks.json`)
    })
    expect(readFileSync(hooksPath, 'utf-8')).toBe(text)
    expect(droidHookService.remove()).toMatchObject({ state: 'not_installed' })
    expect(readJson(settingsPath)).toEqual({ hooks: { Stop: USER_STOP } })
  })

  // Droid rejects a hooks.json whose event is not an array, so Orca must not repair it into use.
  it('leaves a non-array hooks.json event alone', () => {
    writeFileSync(settingsPath, '{}')
    writeFileSync(hooksPath, JSON.stringify({ Stop: null }))

    droidHookService.install()
    expect(readJson(hooksPath)).toEqual({ Stop: null })
  })

  it.each(['local', 'remote'] as const)(
    'installs %s hooks beside non-object hook entries',
    async (target) => {
      const settingsHooks = { Stop: [null, { hooks: [null] }] }
      writeFileSync(settingsPath, JSON.stringify({ hooks: settingsHooks }))
      writeFileSync(hooksPath, JSON.stringify({ PreToolUse: [null] }))

      const status =
        target === 'local'
          ? droidHookService.install()
          : await droidHookService.installRemote(localDiskSftp(), home)

      expect(status).toMatchObject({ state: 'installed' })
      expect(managedEvents(readJson(settingsPath).hooks)).toEqual(EVENTS)
      expect(droidHookService.remove()).toMatchObject({ state: 'not_installed' })
      expect(readJson(settingsPath)).toEqual({ hooks: settingsHooks })
      expect(readJson(hooksPath)).toEqual({ PreToolUse: [null] })
    }
  )

  it('reports hooksDisabled set in hooks.json', () => {
    writeFileSync(settingsPath, '{}')
    writeFileSync(hooksPath, JSON.stringify({ hooksDisabled: true }))

    expect(droidHookService.install()).toMatchObject({
      state: 'partial',
      detail: 'Droid hooks are disabled in Factory settings'
    })
    expect(readJson(hooksPath)).toEqual({ hooksDisabled: true })
  })

  // A directory stands in for any read failure other than a missing file.
  it('installs settings.json hooks when hooks.json cannot be read', async () => {
    writeFileSync(settingsPath, JSON.stringify({ hooks: { Stop: USER_STOP } }))
    mkdirSync(hooksPath)

    expect(droidHookService.install()).toMatchObject({ state: 'installed' })
    expect(await droidHookService.installRemote(localDiskSftp(), home)).toMatchObject({
      state: 'installed',
      configPath: `${home}/.factory/settings.json`
    })
    expect(managedEvents(readJson(settingsPath).hooks)).toEqual(EVENTS)
  })

  // Droid reads the legacy hooks/hooks.json only while hooks.json is absent.
  it('edits the legacy hooks/hooks.json while hooks.json is absent', async () => {
    const legacyPath = join(factoryDir, 'hooks', 'hooks.json')
    mkdirSync(join(factoryDir, 'hooks'))
    writeFileSync(legacyPath, JSON.stringify({ Stop: USER_STOP }))

    expect(droidHookService.install()).toMatchObject({
      state: 'installed',
      additionalConfigPaths: [legacyPath]
    })
    await droidHookService.installRemote(localDiskSftp(), home)
    expect(existsSync(hooksPath)).toBe(false)
    expect(managedEvents(readJson(legacyPath))).toEqual(['Stop'])
    expect(managedEvents(effectiveHooks(legacyPath))).toEqual(EVENTS)
  })

  // STA-17696: installing and removing Orca hooks must preserve unrelated and composite user commands.
  it.each(['hooks.json', 'hooks/hooks.json'] as const)(
    'preserves composite and user-maintained commands referencing the Orca hook in %s',
    async (relativeHooksFile) => {
      const targetHooksPath = join(factoryDir, relativeHooksFile)
      mkdirSync(join(factoryDir, 'hooks'), { recursive: true })
      const scriptPath = join(home, '.orca', 'agent-hooks', 'droid-hook.sh')
      const wrappedOrca = wrapPosixHookCommand(scriptPath)
      const compositeHooks = [
        {
          hooks: [
            { type: 'command', command: `my-pre-hook && ${scriptPath}` },
            { type: 'command', command: `${wrappedOrca} && notify-send done` },
            { type: 'command', command: `python3 wrapper.py ${scriptPath}` },
            { type: 'command', command: 'python3', args: ['wrapper.py', scriptPath] },
            { type: 'command', command: `${scriptPath}.custom` },
            { type: 'command', command: 'say done' }
          ]
        }
      ]
      writeFileSync(settingsPath, JSON.stringify({ hooks: { Stop: compositeHooks } }))
      writeFileSync(targetHooksPath, JSON.stringify({ Stop: compositeHooks }))

      expect(droidHookService.install()).toMatchObject({ state: 'installed' })
      expect(await droidHookService.installRemote(localDiskSftp(), home)).toMatchObject({
        state: 'installed'
      })
      expect(droidHookService.remove()).toMatchObject({ state: 'not_installed' })
      expect(readJson(targetHooksPath)).toEqual({ Stop: compositeHooks })
      expect(readJson(settingsPath)).toEqual({ hooks: { Stop: compositeHooks } })
    }
  )

  it('recognizes Orca-owned command forms while rejecting composite user commands', () => {
    const matches = createManagedCommandMatcher('droid-hook.sh')
    const posix = '/home/u/.orca/agent-hooks/droid-hook.sh'
    const winCmd = 'C:\\Users\\Zoë & Co\\.orca\\agent-hooks\\droid-hook.cmd'

    expect(matches(posix)).toBe(true)
    expect(matches(`/bin/sh '${posix}'`)).toBe(true)
    expect(matches(wrapPosixHookCommand(posix))).toBe(true)
    expect(matches(wrapRuntimeHomeHookCommand('droid-hook'))).toBe(true)
    expect(matches(wrapWindowsHookCommand(winCmd))).toBe(true)
    expect(matches('C:/Users/u/.orca/agent-hooks/orca-agent-hook.exe droid')).toBe(true)

    expect(matches(`my-hook && ${posix}`)).toBe(false)
    expect(matches(`${wrapPosixHookCommand(posix)}; my-hook`)).toBe(false)
    expect(matches(`tee /tmp/log | /bin/sh '${posix}'`)).toBe(false)
    expect(matches(`${wrapWindowsHookCommand(winCmd)} && my-hook`)).toBe(false)
    expect(matches('C:/Users/u/.orca/agent-hooks/orca-agent-hook.exe droid && my-hook')).toBe(false)
    expect(matches(`${posix}.custom`)).toBe(false)
    // A quoted `]` in the profile path must not hide Orca's own wrapper.
    expect(matches(wrapPosixHookCommand('/home/Dev [QA]/.orca/agent-hooks/droid-hook.sh'))).toBe(
      true
    )
    expect(matches(wrapPosixHookCommand('/home/Dev && QA/.orca/agent-hooks/droid-hook.sh'))).toBe(
      true
    )
    expect(matches(`TAG='x\\'; my-hook # ' /bin/sh '${posix}'`)).toBe(false)
    expect(
      matches(
        `if [ -f '${posix}' ]; then /bin/sh '${posix}'; else printf '%s\\n'\n'my-hook'; :; fi`
      )
    ).toBe(false)
    // A user condition around the Orca script is the user's wrapper, not Orca's.
    expect(matches(`if [ "$(date +%u)" -lt 6 ]; then /bin/sh '${posix}'; fi`)).toBe(false)
    expect(matches(`sh\n${posix}`)).toBe(false)
    const encoded = wrapWindowsHookCommand(winCmd).match(/-EncodedCommand\s+(\S+)/)![1]
    expect(matches(`powershell.exe -NoProfile -EncodedCommand ${encoded}`)).toBe(true)
    expect(matches(`team-powershell.exe -NoProfile -EncodedCommand ${encoded}`)).toBe(false)
  })

  // STA-17697: remote install must preserve simultaneous user edits to hooks.json and settings.json.
  it('re-merges onto a simultaneous user edit to remote hooks.json instead of overwriting it', async () => {
    writeFileSync(settingsPath, JSON.stringify({ hooks: { PreToolUse: USER_GUARD } }))
    writeFileSync(hooksPath, JSON.stringify({ Stop: USER_STOP }))

    let injected = false
    const racingSftp = localDiskSftp({
      onBeforeWrite: (path) => {
        // Simulate a user saving a new hook in hooks.json right before Orca publishes its temp file.
        if (!injected && path.startsWith(`${factoryDir}/.`)) {
          injected = true
          writeFileSync(
            hooksPath,
            JSON.stringify({
              Stop: [...USER_STOP, { hooks: [{ type: 'command', command: 'say user-edit' }] }],
              Notification: [{ hooks: [{ type: 'command', command: 'notify-user' }] }]
            })
          )
        }
      }
    })

    const status = await droidHookService.installRemote(racingSftp, home)

    expect(status).toMatchObject({ state: 'installed' })
    const savedHooks = readJson(hooksPath)
    expect(JSON.stringify(savedHooks)).toContain('say user-edit')
    expect(JSON.stringify(savedHooks)).toContain('notify-user')
    expect(managedEvents(savedHooks)).toEqual(['Notification', 'Stop'])
    expect(managedEvents(effectiveHooks())).toEqual(EVENTS)
  })

  it('preserves a user JSONC save that lands during remote install without overwriting it', async () => {
    writeFileSync(settingsPath, JSON.stringify({ hooks: {} }))
    writeFileSync(hooksPath, JSON.stringify({ Stop: USER_STOP }))
    const userJsonc =
      '{ // user comment\n  "Stop": [{ "hooks": [{ "type": "command", "command": "say keep" }] }]\n}\n'

    let injected = false
    const racingSftp = localDiskSftp({
      onBeforeWrite: (path) => {
        if (!injected && path.startsWith(`${factoryDir}/.`)) {
          injected = true
          writeFileSync(hooksPath, userJsonc)
        }
      }
    })

    const status = await droidHookService.installRemote(racingSftp, home)

    expect(status).toMatchObject({
      state: 'partial',
      detail: `Managed hook missing for events: Stop; ${hooksPath} has comments; Orca cannot edit it`
    })
    expect(readFileSync(hooksPath, 'utf-8')).toBe(userJsonc)
  })

  it('fails cleanly without overwriting when remote hooks.json keeps changing on every attempt', async () => {
    writeFileSync(settingsPath, JSON.stringify({ hooks: {} }))
    writeFileSync(hooksPath, JSON.stringify({ Stop: USER_STOP }))

    let revision = 0
    const racingSftp = localDiskSftp({
      onBeforeWrite: (path) => {
        if (path.startsWith(`${factoryDir}/.`)) {
          revision += 1
          writeFileSync(
            hooksPath,
            JSON.stringify({
              Stop: [{ hooks: [{ type: 'command', command: `user-rev-${revision}` }] }]
            })
          )
        }
      }
    })

    const status = await droidHookService.installRemote(racingSftp, home)

    expect(status).toMatchObject({
      state: 'error',
      configPath: hooksPath,
      detail: `${hooksPath} kept changing while Orca updated it`
    })
    expect(readJson(hooksPath)).toEqual({
      Stop: [{ hooks: [{ type: 'command', command: `user-rev-${revision}` }] }]
    })
  })
})
