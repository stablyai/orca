import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type * as osModule from 'node:os'
import { join } from 'node:path'
import * as refresh from '../agent-hooks/managed-hook-script-refresh'
import { readHooksJson, writeHooksJson } from '../agent-hooks/installer-utils'
import { ClaudeHookService } from './hook-service'
import { getWindowsManagedLifecycleHook } from './hook-settings'
import { getWindowsClaudeHookEntry, getWindowsClaudeHookPayloadPath } from './windows-hook-files'
import { codebuddyHookService } from '../codebuddy/hook-service'
import { qoderHookService } from '../qoder/hook-service'
import { openClaudeHookService } from '../openclaude/hook-service'

const { home } = vi.hoisted(() => ({ home: { path: '' } }))
vi.mock('node:os', async (original) => ({
  ...(await original<typeof osModule>()),
  homedir: () => home.path
}))
vi.mock('electron', () => ({ app: { getPath: () => home.path } }))

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
let entry: string
let payload: string
let settings: string
const service = new ClaudeHookService()

beforeEach(() => {
  home.path = mkdtempSync(join(tmpdir(), 'claude-windows-files-'))
  entry = join(home.path, '.orca', 'agent-hooks', 'claude-hook.cmd')
  payload = getWindowsClaudeHookPayloadPath(entry)
  settings = join(home.path, '.claude', 'settings.json')
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
})

afterEach(() => {
  Object.defineProperty(process, 'platform', platform)
  vi.restoreAllMocks()
  rmSync(home.path, { recursive: true, force: true })
})

describe('Windows Claude hook files', () => {
  it('installs a delegating entry and a payload that answers before bounded delivery', () => {
    expect(service.install().state).toBe('installed')
    expect(readFileSync(entry, 'utf8')).toBe(getWindowsClaudeHookEntry())
    const body = readFileSync(payload, 'utf8')
    expect(body.indexOf('echo {}')).toBeLessThan(body.indexOf('curl.exe'))
    expect(body).toContain('--connect-timeout 0.5 --max-time 1.5')
    expect(body).toContain('--data-urlencode "payload@-" >nul 2>&1\r\nexit /b 0')
    expect(body).toContain('DEVIN_PROJECT_DIR')
  })

  it('repairs a missing payload from the surviving entry without touching settings', async () => {
    service.install()
    rmSync(payload)
    expect(service.getStatus().state).toBe('partial')
    const configBefore = readFileSync(settings, 'utf8')
    await service.refreshManagedScripts()
    expect(service.getStatus().state).toBe('installed')
    expect(readFileSync(entry, 'utf8')).toBe(getWindowsClaudeHookEntry())
    expect(readFileSync(payload, 'utf8')).toContain('/hook/claude')
    expect(readFileSync(settings, 'utf8')).toBe(configBefore)
  })

  it.each(['entry', 'both'])('leaves a missing %s to install()', async (missing) => {
    service.install()
    rmSync(entry)
    if (missing === 'both') {
      rmSync(payload)
    }
    await service.refreshManagedScripts()
    expect(existsSync(entry)).toBe(false)
    expect(service.getStatus().state).toBe('partial')
    expect(service.install().state).toBe('installed')
    expect(readFileSync(entry, 'utf8')).toBe(getWindowsClaudeHookEntry())
    expect(readFileSync(payload, 'utf8')).toContain('/hook/claude')
  })

  it('leaves the old single-file entry intact when payload publication fails', async () => {
    mkdirSync(join(home.path, '.orca', 'agent-hooks'), { recursive: true })
    const oldEntry = '@echo off\r\necho {}\r\nexit /b 0\r\n'
    writeFileSync(entry, oldEntry)
    vi.spyOn(refresh, 'restoreManagedScript').mockRejectedValueOnce(new Error('disk full'))
    await expect(service.refreshManagedScripts()).rejects.toThrow('disk full')
    expect(readFileSync(entry, 'utf8')).toBe(oldEntry)
    expect(existsSync(payload)).toBe(false)
  })

  it('publishes the payload before replacing a legacy entry', async () => {
    mkdirSync(join(home.path, '.orca', 'agent-hooks'), { recursive: true })
    writeFileSync(entry, 'legacy payload')
    const restore = refresh.restoreManagedScript
    const writes: string[] = []
    vi.spyOn(refresh, 'restoreManagedScript').mockImplementation(async (path, content) => {
      if (path === entry) {
        expect(readFileSync(payload, 'utf8')).toContain('/hook/claude')
      }
      writes.push(path)
      await restore(path, content)
    })
    await service.refreshManagedScripts()
    expect(writes).toEqual([payload, entry])
    expect(existsSync(settings)).toBe(false)
  })

  it('keeps inert scripts on uninstall and never creates an entry from an orphan payload', async () => {
    service.install()
    service.remove()
    expect(JSON.stringify(readHooksJson(settings))).not.toContain('claude-hook.cmd')
    // Like every other agent's script: a session still holding the old settings keeps answering.
    expect(readFileSync(entry, 'utf8')).toBe(getWindowsClaudeHookEntry())
    rmSync(entry)
    writeFileSync(payload, 'orphan payload')
    await service.refreshManagedScripts()
    expect(existsSync(entry)).toBe(false)
    expect(readFileSync(payload, 'utf8')).toBe('orphan payload')
  })

  it('migrates old command forms while preserving user hooks', () => {
    const encoded = getWindowsManagedLifecycleHook(
      'C:\\Users\\%name%\\.orca\\agent-hooks\\claude-hook.cmd'
    )
    writeHooksJson(settings, {
      hooks: {
        Stop: [{ hooks: [encoded, { type: 'command', command: 'echo user-hook' }] }],
        PreToolUse: [
          {
            hooks: [
              { type: 'command', command: 'C:/old/.orca/agent-hooks/claude-hook.cmd || echo {}' }
            ]
          }
        ]
      }
    })
    service.install()
    const config = JSON.stringify(readHooksJson(settings))
    expect(config).not.toContain('|| echo {}')
    expect(config).not.toContain('C:/old/')
    expect(config).toContain('echo user-hook')
    expect(service.getStatus().state).toBe('installed')
  })

  it('keeps compatible agents on their existing single-file scripts', async () => {
    for (const [name, compatible] of [
      ['qoder', qoderHookService],
      ['codebuddy', codebuddyHookService],
      ['openclaude', openClaudeHookService]
    ] as const) {
      expect(compatible.install().state).toBe('installed')
      await compatible.refreshManagedScripts()
      const path = join(home.path, '.orca', 'agent-hooks', `${name}-hook.cmd`)
      expect(readFileSync(path, 'utf8')).toContain(
        `/hook/${name === 'openclaude' ? 'claude' : name}`
      )
      expect(readFileSync(path, 'utf8')).not.toContain('claude-hook-impl.cmd')
      expect(existsSync(join(home.path, '.orca', 'agent-hooks', `${name}-hook-impl.cmd`))).toBe(
        false
      )
    }
  })
})
