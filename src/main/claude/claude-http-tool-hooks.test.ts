import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/userData'
  }
}))

import { createManagedCommandMatcher } from '../agent-hooks/installer-utils'
import { buildManagedHttpHook } from '../agent-hooks/managed-http-hook'
import {
  isClaudeHttpToolHooksRequested,
  setClaudeHttpToolHookPort,
  startClaudeHttpToolHooks,
  stopClaudeHttpToolHooks
} from './claude-http-tool-hooks'
import { ClaudeHookService } from './hook-service'
import { OPENCLAUDE_HOOK_SETTINGS } from './hook-settings'

type TestHook = { type: string; command?: string; url?: string }
type TestSettings = {
  env?: Record<string, string>
  hooks?: Record<string, { hooks?: TestHook[] }[]>
}

const CURRENT_CLAUDE = { claudeVersion: '2.1.310 (Claude Code)' }
const TOOL_EVENTS = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure']
const SCRIPT_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'Stop',
  'PermissionRequest',
  'SessionEnd'
]
const USER_COMMAND = { type: 'command', command: '/usr/local/bin/audit-tool-use' }
const USER_HTTP = { type: 'http', url: 'http://127.0.0.1:9999/my-own-hook' }
const isClaudeManaged = createManagedCommandMatcher('claude-hook.sh')

let home: string

function settingsPath(): string {
  return join(home, '.claude', 'settings.json')
}

function readSettings(): TestSettings {
  return JSON.parse(readFileSync(settingsPath(), 'utf-8'))
}

function writeSettings(settings: TestSettings): void {
  mkdirSync(join(home, '.claude'), { recursive: true })
  writeFileSync(settingsPath(), JSON.stringify(settings))
}

function hooksFor(settings: TestSettings, event: string): TestHook[] {
  return (settings.hooks?.[event] ?? []).flatMap((definition) => definition.hooks ?? [])
}

function managedHooks(settings: TestSettings, event: string): TestHook[] {
  return hooksFor(settings, event).filter((hook) =>
    isClaudeManaged(hook.type === 'http' ? hook.url : hook.command)
  )
}

function expectToolEventsOn(settings: TestSettings, form: 'http' | 'command', port?: number) {
  for (const event of TOOL_EVENTS) {
    const managed = managedHooks(settings, event)
    expect(managed, event).toHaveLength(1)
    expect(managed[0].type, event).toBe(form)
    if (port !== undefined) {
      expect(managed[0].url).toBe(`http://127.0.0.1:${port}/hook/claude?orca-hook=claude-hook`)
    }
  }
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orca-claude-http-hooks-'))
  vi.stubEnv('HOME', home)
  vi.stubEnv('USERPROFILE', home)
  vi.stubEnv('CLAUDE_CODE_SUBPROCESS_ENV_SCRUB', '')
})

afterEach(() => {
  setClaudeHttpToolHookPort(null)
  vi.unstubAllEnvs()
  rmSync(home, { recursive: true, force: true })
})

describe('managed http hook entry', () => {
  it('declares every interpolated header and carries no worktree path', () => {
    const hook = buildManagedHttpHook({ port: 45000, source: 'claude' }, 'claude-hook', 10)

    const referenced = Object.values(hook.headers).flatMap((value) =>
      [...value.matchAll(/\$\{([A-Z_]+)\}/g)].map((match) => match[1])
    )
    expect(new Set(referenced)).toEqual(new Set(hook.allowedEnvVars))
    expect(hook.allowedEnvVars).not.toContain('ORCA_WORKTREE_ID')
    expect(hook.allowedEnvVars).toContain('CLAUDE_JOB_DIR')
  })

  it('is recognized only as the Claude script entry it replaces', () => {
    const url = buildManagedHttpHook({ port: 45000, source: 'claude' }, 'claude-hook', 10).url

    expect(isClaudeManaged(url)).toBe(true)
    expect(createManagedCommandMatcher('openclaude-hook.sh')(url)).toBe(false)
    expect(isClaudeManaged(USER_HTTP.url)).toBe(false)
    expect(isClaudeManaged(url.replace('127.0.0.1', 'localhost'))).toBe(false)
    // 127.0.0.1 as userinfo passes a raw prefix check; the parsed host is example.com.
    expect(isClaudeManaged('http://127.0.0.1:@example.com/hook/claude?orca-hook=claude-hook')).toBe(
      false
    )
  })

  it('is requested only through the env opt-in, and never on Windows', () => {
    expect(isClaudeHttpToolHooksRequested({ ORCA_CLAUDE_HTTP_HOOKS: '1' }, 'darwin')).toBe(true)
    expect(isClaudeHttpToolHooksRequested({ ORCA_CLAUDE_HTTP_HOOKS: '1' }, 'linux')).toBe(true)
    expect(isClaudeHttpToolHooksRequested({ ORCA_CLAUDE_HTTP_HOOKS: '1' }, 'win32')).toBe(false)
    expect(isClaudeHttpToolHooksRequested({}, 'darwin')).toBe(false)
  })
})

describe.skipIf(process.platform === 'win32')('Claude http tool hooks install', () => {
  it('moves only the tool events to http and reports the install as complete', () => {
    setClaudeHttpToolHookPort(45001)
    const service = new ClaudeHookService()

    expect(service.install(CURRENT_CLAUDE).state).toBe('installed')

    const settings = readSettings()
    expectToolEventsOn(settings, 'http', 45001)
    for (const event of SCRIPT_EVENTS) {
      expect(
        managedHooks(settings, event).map((hook) => hook.type),
        event
      ).toEqual(['command'])
    }
    expect(service.getStatus(CURRENT_CLAUDE).state).toBe('installed')
  })

  it('rewrites nothing on a repeated install', () => {
    setClaudeHttpToolHookPort(45001)
    const service = new ClaudeHookService()
    service.install(CURRENT_CLAUDE)
    const first = readFileSync(settingsPath(), 'utf-8')

    service.install(CURRENT_CLAUDE)

    expect(readFileSync(settingsPath(), 'utf-8')).toBe(first)
    expect(existsSync(`${settingsPath()}.bak`)).toBe(false)
  })

  it('swaps script and http entries in place without duplicates or touching user hooks', () => {
    writeSettings({ hooks: { PreToolUse: [{ hooks: [USER_COMMAND, USER_HTTP] }] } })
    const service = new ClaudeHookService()
    service.install(CURRENT_CLAUDE)
    expectToolEventsOn(readSettings(), 'command')

    startClaudeHttpToolHooks(45002)
    expectToolEventsOn(readSettings(), 'http', 45002)
    expect(service.getStatus(CURRENT_CLAUDE).state).toBe('installed')

    startClaudeHttpToolHooks(45003)
    expectToolEventsOn(readSettings(), 'http', 45003)

    stopClaudeHttpToolHooks()
    const settings = readSettings()
    expectToolEventsOn(settings, 'command')
    expect(service.getStatus(CURRENT_CLAUDE).state).toBe('installed')
    expect(hooksFor(settings, 'PreToolUse')).toEqual(
      expect.arrayContaining([USER_COMMAND, USER_HTTP])
    )
  })

  it('never adds tool events Orca has not installed', () => {
    writeSettings({ hooks: { Stop: [{ hooks: [USER_COMMAND] }] } })
    const before = readFileSync(settingsPath(), 'utf-8')

    startClaudeHttpToolHooks(45004)

    expect(readFileSync(settingsPath(), 'utf-8')).toBe(before)
  })

  it('removes http entries on opt-out and keeps user hooks', () => {
    writeSettings({ hooks: { PreToolUse: [{ hooks: [USER_HTTP] }] } })
    setClaudeHttpToolHookPort(45005)
    const service = new ClaudeHookService()
    service.install(CURRENT_CLAUDE)

    expect(service.remove().state).toBe('not_installed')

    const settings = readSettings()
    for (const event of [...TOOL_EVENTS, ...SCRIPT_EVENTS]) {
      expect(managedHooks(settings, event), event).toEqual([])
    }
    expect(hooksFor(settings, 'PreToolUse')).toEqual([USER_HTTP])
  })

  it('moves a previous run http entries to the new port before any install probes the CLI', async () => {
    setClaudeHttpToolHookPort(45010)
    new ClaudeHookService().install(CURRENT_CLAUDE)
    expectToolEventsOn(readSettings(), 'http', 45010)
    setClaudeHttpToolHookPort(null)

    // A fresh module is a fresh Orca process: the listener binds before any install runs.
    vi.resetModules()
    const restarted = await import('./claude-http-tool-hooks')
    restarted.startClaudeHttpToolHooks(45011)
    expectToolEventsOn(readSettings(), 'http', 45011)

    restarted.stopClaudeHttpToolHooks()
    expectToolEventsOn(readSettings(), 'command')
  })

  it('leaves script entries on the script until an install probes the CLI', async () => {
    new ClaudeHookService().install(CURRENT_CLAUDE)
    expectToolEventsOn(readSettings(), 'command')

    vi.resetModules()
    const restarted = await import('./claude-http-tool-hooks')
    restarted.startClaudeHttpToolHooks(45012)
    expectToolEventsOn(readSettings(), 'command')
    restarted.stopClaudeHttpToolHooks()
  })

  it('keeps the script for a Claude CLI older than http hooks', () => {
    setClaudeHttpToolHookPort(45008)

    new ClaudeHookService().install({ claudeVersion: '2.1.62 (Claude Code)' })

    expectToolEventsOn(readSettings(), 'command')
  })

  it('keeps the script when Claude scrubs credential names from hook env', () => {
    writeSettings({ env: { CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1' } })
    setClaudeHttpToolHookPort(45006)

    new ClaudeHookService().install(CURRENT_CLAUDE)

    expectToolEventsOn(readSettings(), 'command')
  })

  it('keeps the script for Claude profiles and Claude-compatible agents', () => {
    setClaudeHttpToolHookPort(45007)
    const profileDir = join(home, 'claude-profile-a')

    new ClaudeHookService().install({ ...CURRENT_CLAUDE, configDir: profileDir })
    new ClaudeHookService({
      agent: 'openclaude',
      displayName: 'OpenClaude',
      settings: OPENCLAUDE_HOOK_SETTINGS
    }).install()

    for (const path of [
      join(profileDir, 'settings.json'),
      join(home, '.openclaude', 'settings.json')
    ]) {
      const settings: TestSettings = JSON.parse(readFileSync(path, 'utf-8'))
      const types = TOOL_EVENTS.flatMap((event) => hooksFor(settings, event)).map((h) => h.type)
      expect(types.length, path).toBeGreaterThan(0)
      expect(new Set(types), path).toEqual(new Set(['command']))
    }
  })
})
