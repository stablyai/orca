import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type * as OsModule from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
const sandbox = vi.hoisted(() => ({ home: '' }))
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof OsModule>()),
  homedir: () => sandbox.home
}))
vi.mock('electron', () => ({ app: { getPath: () => sandbox.home } }))
import { getManagedLifecycleHook, getWindowsManagedLifecycleHook } from '../claude/hook-settings'
import { codebuddyHookService, CODEBUDDY_HOOK_EVENTS } from './hook-service'

beforeAll(() => {
  sandbox.home = mkdtempSync(join(tmpdir(), 'orca-codebuddy-test-'))
  mkdirSync(join(sandbox.home, '.codebuddy'))
})
afterAll(() => rmSync(sandbox.home, { recursive: true, force: true }))

describe('CodeBuddy managed hooks', () => {
  it('preserves user configuration through repeated install and removal', () => {
    const path = join(sandbox.home, '.codebuddy', 'settings.json')
    const userHook = { hooks: [{ type: 'command', command: 'echo user-hook' }] }
    const settings = {
      model: 'custom',
      hooks: { Stop: [userHook] },
      statusLine: { command: 'user-status' }
    }
    writeFileSync(path, JSON.stringify(settings))
    expect(codebuddyHookService.install().state).toBe('installed')
    expect(codebuddyHookService.install().state).toBe('installed')
    const installed = JSON.parse(readFileSync(path, 'utf8'))
    for (const event of CODEBUDDY_HOOK_EVENTS) {
      expect(installed.hooks[event]).toHaveLength(event === 'Stop' ? 2 : 1)
    }
    expect(installed.statusLine).toEqual(settings.statusLine)
    expect(codebuddyHookService.remove().state).toBe('not_installed')
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject(settings)
  })

  it('leaves malformed user settings untouched', () => {
    const path = join(sandbox.home, '.codebuddy', 'settings.json')
    writeFileSync(path, '{broken')
    expect(codebuddyHookService.install().state).toBe('error')
    expect(readFileSync(path, 'utf8')).toBe('{broken')
  })
})

describe('CodeBuddy managed hooks on Windows', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  afterEach(() => Object.defineProperty(process, 'platform', platform))

  // CodeBuddy spawns `shell: 'powershell'` hooks as bare `pwsh`, which stock Windows lacks (#27182).
  it('registers a shell-free command and replaces the legacy pwsh registration', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const path = join(sandbox.home, '.codebuddy', 'settings.json')
    const userHook = { type: 'command', command: 'echo user-hook' }
    const scriptPath = join(sandbox.home, '.orca', 'agent-hooks', 'codebuddy-hook.cmd')
    const legacyHook = getManagedLifecycleHook(scriptPath, {
      configDirName: '.codebuddy',
      scriptBaseName: 'codebuddy-hook',
      usesWindowsCompatLauncher: true,
      windowsHookShell: 'powershell'
    })
    expect(legacyHook.shell).toBe('powershell')
    writeFileSync(
      path,
      JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [legacyHook, userHook] }] } })
    )
    expect(codebuddyHookService.getStatus().state).not.toBe('installed')

    expect(codebuddyHookService.install().state).toBe('installed')
    const installed = JSON.parse(readFileSync(path, 'utf8'))
    const expected = getWindowsManagedLifecycleHook(scriptPath)
    for (const event of CODEBUDDY_HOOK_EVENTS) {
      const hooks = installed.hooks[event].flatMap((d: { hooks: unknown[] }) => d.hooks)
      expect(hooks).toContainEqual(expected)
      for (const hook of hooks) {
        expect(hook).not.toHaveProperty('shell')
      }
    }
    expect(JSON.stringify(installed)).toContain('echo user-hook')
    expect(JSON.stringify(installed)).not.toContain(legacyHook.command)
  })
})
