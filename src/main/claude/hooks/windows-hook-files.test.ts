import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type * as osModule from 'node:os'
import { join } from 'node:path'
import * as refresh from '../../agent-hooks/installation/scripts/managed-hook-script-refresh'
import { readHooksJson } from '../../agent-hooks/installation/configuration/hooks-json-read'
import { writeHooksJson } from '../../agent-hooks/installation/configuration/hooks-json-write'
import { ClaudeHookService } from '../hook-service'
import { getWindowsManagedLifecycleHook } from './hook-settings'
import { getWindowsClaudeHookPayloadPath } from './windows-hook-files'

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
  it('leaves the old single-file entry intact when payload publication fails', async () => {
    mkdirSync(join(home.path, '.orca', 'agent-hooks'), { recursive: true })
    const oldEntry = '@echo off\r\necho {}\r\nexit /b 0\r\n'
    writeFileSync(entry, oldEntry)
    vi.spyOn(refresh, 'restoreManagedScript').mockRejectedValueOnce(new Error('disk full'))
    await expect(service.refreshManagedScripts()).rejects.toThrow('disk full')
    expect(readFileSync(entry, 'utf8')).toBe(oldEntry)
    expect(existsSync(payload)).toBe(false)
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
})
