// Why (#11549 aftermath): a CLI that falls off PATH keeps its user-wide config invoking
// Orca's script while the presence gate skips install() forever. These tests pin the
// repair — existing scripts come current, missing ones are never created.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as osModule from 'node:os'

let isolatedUserDataDir = ''
let previousUserDataPath: string | undefined

beforeEach(() => {
  previousUserDataPath = process.env.ORCA_USER_DATA_PATH
  isolatedUserDataDir = mkdtempSync(join(tmpdir(), 'orca-hook-refresh-user-data-'))
  process.env.ORCA_USER_DATA_PATH = isolatedUserDataDir
})

afterEach(() => {
  if (previousUserDataPath === undefined) {
    delete process.env.ORCA_USER_DATA_PATH
  } else {
    process.env.ORCA_USER_DATA_PATH = previousUserDataPath
  }
  rmSync(isolatedUserDataDir, { recursive: true, force: true })
})

const { homedirMock } = vi.hoisted(() => ({
  homedirMock: vi.fn<() => string>()
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/orca-user-data'
  }
}))

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof osModule>()
  return {
    ...actual,
    homedir: homedirMock.mockImplementation(actual.homedir)
  }
})

import { refreshManagedScriptIfPresent } from './managed-hook-script-refresh'
import {
  MANAGED_AGENT_HOOK_INSTALLERS,
  MANAGED_AGENT_HOOK_SCRIPT_REFRESHERS
} from './managed-agent-hook-registry'
import { wrapRuntimeHomeHookCommand } from './runtime-home-hook-command'
import { ClaudeHookService } from '../claude/hook-service'
import {
  CLAUDE_HOOK_SETTINGS,
  getManagedCommand,
  getManagedLifecycleHook,
  getManagedScriptPath,
  getStatusLineScriptPath,
  OPENCLAUDE_HOOK_SETTINGS
} from '../claude/hook-settings'

async function withPlatform<T>(platform: NodeJS.Platform, run: () => T | Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  try {
    return await run()
  } finally {
    if (original) {
      Object.defineProperty(process, 'platform', original)
    }
  }
}

const STALE_WINDOWS_HOOK = [
  '@echo off',
  'setlocal',
  'if "%ORCA_AGENT_HOOK_PORT%"=="" goto :orca_agent_hook_drain_stdin',
  ':orca_agent_hook_drain_stdin',
  '"%SystemRoot%\\System32\\more.com" >nul 2>nul',
  'exit /b 0',
  ''
].join('\r\n')

describe('refreshManagedScriptIfPresent', () => {
  it('rewrites an existing script and refuses to create a missing one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-hook-refresh-unit-'))
    try {
      const present = join(dir, 'present.cmd')
      writeFileSync(present, 'stale')
      expect(await refreshManagedScriptIfPresent(present, 'fresh')).toBe(true)
      expect(readFileSync(present, 'utf8')).toBe('fresh')

      if (process.platform !== 'win32') {
        chmodSync(present, 0o600)
      }
      const fixedTime = new Date(1_000)
      utimesSync(present, fixedTime, fixedTime)
      expect(await refreshManagedScriptIfPresent(present, 'fresh')).toBe(true)
      expect(statSync(present).mtimeMs).toBe(fixedTime.getTime())
      if (process.platform !== 'win32') {
        expect(statSync(present).mode & 0o777).toBe(0o755)
      }

      const missing = join(dir, 'missing.cmd')
      expect(await refreshManagedScriptIfPresent(missing, 'fresh')).toBe(false)
      expect(existsSync(missing)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('managed hook script refresh', () => {
  it('brings a stale leaking script current without touching agent config', async () => {
    const home = mkdtempSync(join(tmpdir(), 'orca-hook-refresh-'))
    homedirMock.mockReturnValue(home)
    try {
      // Why: the bug population has a script (from a past install) but no reachable
      // CLI — and possibly no config dir Orca may create. Seed only the script.
      const hooksDir = join(home, '.orca', 'agent-hooks')
      mkdirSync(hooksDir, { recursive: true })
      writeFileSync(join(hooksDir, 'claude-hook.cmd'), STALE_WINDOWS_HOOK)

      await withPlatform('win32', () => new ClaudeHookService().refreshManagedScripts())

      const refreshed = readFileSync(join(hooksDir, 'claude-hook.cmd'), 'utf8')
      expect(refreshed).toContain('if "%ORCA_AGENT_HOOK_PORT%"=="" exit /b 0')
      expect(refreshed).not.toContain('if "%ORCA_AGENT_HOOK_PORT%"=="" goto')
      // Why: refresh must not resurrect config for a CLI the user may have removed.
      expect(existsSync(join(home, '.claude'))).toBe(false)
      // Why: the statusline script was never installed here, so it must not appear.
      expect(existsSync(join(hooksDir, 'claude-statusline.cmd'))).toBe(false)
    } finally {
      homedirMock.mockImplementation(() => process.env.HOME ?? tmpdir())
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('covers every shared launcher script with a refresher', async () => {
    const home = mkdtempSync(join(tmpdir(), 'orca-hook-refresh-coverage-'))
    homedirMock.mockReturnValue(home)
    const previousGrokHome = process.env.GROK_HOME
    const previousKimiHome = process.env.KIMI_CODE_HOME
    delete process.env.GROK_HOME
    delete process.env.KIMI_CODE_HOME
    try {
      await withPlatform('win32', () => {
        for (const [, install] of MANAGED_AGENT_HOOK_INSTALLERS) {
          install()
        }
      })
      const hooksDir = join(home, '.orca', 'agent-hooks')
      const files = readdirSync(hooksDir)
      expect(files.length).toBeGreaterThan(0)
      const refresherAgents = MANAGED_AGENT_HOOK_SCRIPT_REFRESHERS.map(([agent]) => agent)
      // Why: an installer that writes a shared launcher but skips the refresher list would
      // recreate the frozen-stale-script class this suite exists to prevent.
      for (const file of files) {
        expect(
          refresherAgents.some((agent) => file.startsWith(`${agent}-`)),
          `${file} is written to ~/.orca/agent-hooks but no refresher owns it`
        ).toBe(true)
      }
      // Why: the reverse direction — a refresher naming an agent that writes nothing is a
      // stale registry entry, likely a renamed script file.
      for (const agent of refresherAgents) {
        expect(
          files.some((file) => file.startsWith(`${agent}-`)),
          `refresher for ${agent} matches no installed script`
        ).toBe(true)
      }
    } finally {
      homedirMock.mockImplementation(() => process.env.HOME ?? tmpdir())
      if (previousGrokHome === undefined) {
        delete process.env.GROK_HOME
      } else {
        process.env.GROK_HOME = previousGrokHome
      }
      if (previousKimiHome === undefined) {
        delete process.env.KIMI_CODE_HOME
      } else {
        process.env.KIMI_CODE_HOME = previousKimiHome
      }
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('creates nothing anywhere when no managed scripts exist', async () => {
    const home = mkdtempSync(join(tmpdir(), 'orca-hook-refresh-empty-'))
    homedirMock.mockReturnValue(home)
    try {
      await withPlatform('win32', async () => {
        for (const [agent, refresh] of MANAGED_AGENT_HOOK_SCRIPT_REFRESHERS) {
          await expect(refresh(), `${agent} refresh on empty home`).resolves.toBeUndefined()
        }
      })
      // Why: a refresh pass on a machine with no prior installs must be a strict no-op.
      expect(readdirSync(home)).toEqual([])
    } finally {
      homedirMock.mockImplementation(() => process.env.HOME ?? tmpdir())
      rmSync(home, { recursive: true, force: true })
    }
  })
})

function staleWindowsBranchCommand(scriptBaseName: string): string {
  return wrapRuntimeHomeHookCommand(scriptBaseName, {
    includeWindowsBranch: true,
    neutralJsonWhenMissing: true
  })
}

function makeOpenClaudeService(): ClaudeHookService {
  return new ClaudeHookService({
    agent: 'openclaude',
    displayName: 'OpenClaude',
    settings: OPENCLAUDE_HOOK_SETTINGS
  })
}

describe('managed hook settings refresh (#17202)', () => {
  it('rewrites stale SYSTEMROOT commands without adding events or creating scripts', async () => {
    const home = mkdtempSync(join(tmpdir(), 'orca-hook-refresh-settings-'))
    homedirMock.mockReturnValue(home)
    try {
      const settingsPath = join(home, '.claude', 'settings.json')
      mkdirSync(join(home, '.claude'), { recursive: true })
      const stale = staleWindowsBranchCommand('claude-hook')
      expect(stale).toMatch(/SYSTEMROOT/i)
      writeFileSync(
        settingsPath,
        JSON.stringify({
          env: { AWS_REGION: 'us-west-2' },
          hooks: {
            Stop: [
              { hooks: [{ type: 'command', command: '/usr/local/bin/user-hook' }] },
              { hooks: [{ type: 'command', command: stale, timeout: 10 }] }
            ]
          }
        })
      )

      await new ClaudeHookService().refreshManagedScripts()

      const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
        env?: { AWS_REGION?: string }
        hooks?: Record<string, { hooks: { command: string }[] }[]>
        statusLine?: unknown
      }
      const expected = getManagedLifecycleHook(
        getManagedScriptPath(CLAUDE_HOOK_SETTINGS),
        CLAUDE_HOOK_SETTINGS
      ).command
      expect(parsed.env).toEqual({ AWS_REGION: 'us-west-2' })
      expect(Object.keys(parsed.hooks ?? {})).toEqual(['Stop'])
      const commands = (parsed.hooks?.Stop ?? []).flatMap((definition) =>
        (definition.hooks ?? []).map((hook) => hook.command)
      )
      expect(commands).toContain('/usr/local/bin/user-hook')
      expect(commands).toContain(expected)
      expect(commands).toHaveLength(2)
      if (process.platform !== 'win32') {
        expect(expected).not.toMatch(/SYSTEMROOT/i)
        expect(commands.join('\n')).not.toMatch(/SYSTEMROOT/i)
      }
      expect(parsed.statusLine).toBeUndefined()
      expect(existsSync(join(home, '.orca'))).toBe(false)
    } finally {
      homedirMock.mockImplementation(() => process.env.HOME ?? tmpdir())
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('rewrites a stale managed statusLine and leaves user or empty slots alone', async () => {
    const home = mkdtempSync(join(tmpdir(), 'orca-hook-refresh-statusline-'))
    homedirMock.mockReturnValue(home)
    try {
      const settingsPath = join(home, '.claude', 'settings.json')
      mkdirSync(join(home, '.claude'), { recursive: true })
      const staleStatusLine = staleWindowsBranchCommand('claude-statusline')
      writeFileSync(
        settingsPath,
        JSON.stringify({
          statusLine: { type: 'command', command: staleStatusLine, extra: true },
          hooks: {
            Stop: [
              {
                hooks: [
                  {
                    type: 'command',
                    command: staleWindowsBranchCommand('claude-hook'),
                    timeout: 10
                  }
                ]
              }
            ]
          }
        })
      )

      await new ClaudeHookService().refreshManagedScripts()

      const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
        statusLine?: { type: string; command: string; extra?: boolean }
      }
      expect(parsed.statusLine?.command).toBe(getManagedCommand(getStatusLineScriptPath()))
      expect(parsed.statusLine?.extra).toBe(true)
      if (process.platform !== 'win32') {
        expect(parsed.statusLine?.command).not.toMatch(/SYSTEMROOT/i)
      }

      writeFileSync(
        settingsPath,
        JSON.stringify({
          statusLine: { type: 'command', command: '/usr/local/bin/my-statusline' }
        })
      )
      await new ClaudeHookService().refreshManagedScripts()
      expect(JSON.parse(readFileSync(settingsPath, 'utf8')).statusLine).toEqual({
        type: 'command',
        command: '/usr/local/bin/my-statusline'
      })

      writeFileSync(settingsPath, JSON.stringify({ hooks: {} }))
      await new ClaudeHookService().refreshManagedScripts()
      expect(JSON.parse(readFileSync(settingsPath, 'utf8')).statusLine).toBeUndefined()
    } finally {
      homedirMock.mockImplementation(() => process.env.HOME ?? tmpdir())
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('rewrites existing OpenClaude managed commands without creating Claude config', async () => {
    const home = mkdtempSync(join(tmpdir(), 'orca-hook-refresh-openclaude-'))
    homedirMock.mockReturnValue(home)
    try {
      const settingsPath = join(home, '.openclaude', 'settings.json')
      mkdirSync(join(home, '.openclaude'), { recursive: true })
      const stale = staleWindowsBranchCommand('openclaude-hook')
      writeFileSync(
        settingsPath,
        JSON.stringify({
          hooks: {
            StopFailure: [{ hooks: [{ type: 'command', command: stale, timeout: 10 }] }]
          }
        })
      )

      await makeOpenClaudeService().refreshManagedScripts()

      const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
        hooks?: Record<string, { hooks: { command: string }[] }[]>
      }
      const expected = getManagedLifecycleHook(
        getManagedScriptPath(OPENCLAUDE_HOOK_SETTINGS),
        OPENCLAUDE_HOOK_SETTINGS
      ).command
      expect(Object.keys(parsed.hooks ?? {})).toEqual(['StopFailure'])
      expect(parsed.hooks?.StopFailure?.[0]?.hooks?.[0]?.command).toBe(expected)
      if (process.platform !== 'win32') {
        expect(expected).not.toMatch(/SYSTEMROOT/i)
      }
      expect(existsSync(join(home, '.claude'))).toBe(false)
    } finally {
      homedirMock.mockImplementation(() => process.env.HOME ?? tmpdir())
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('leaves unreadable settings and already-current commands untouched', async () => {
    const home = mkdtempSync(join(tmpdir(), 'orca-hook-refresh-settings-skip-'))
    homedirMock.mockReturnValue(home)
    try {
      const brokenPath = join(home, '.claude', 'settings.json')
      mkdirSync(join(home, '.claude'), { recursive: true })
      writeFileSync(brokenPath, 'not json')
      await new ClaudeHookService().refreshManagedScripts()
      expect(readFileSync(brokenPath, 'utf8')).toBe('not json')

      const current = getManagedLifecycleHook(
        getManagedScriptPath(OPENCLAUDE_HOOK_SETTINGS),
        OPENCLAUDE_HOOK_SETTINGS
      )
      const currentPath = join(home, '.openclaude', 'settings.json')
      mkdirSync(join(home, '.openclaude'), { recursive: true })
      writeFileSync(
        currentPath,
        JSON.stringify({
          hooks: { Stop: [{ hooks: [current] }] }
        })
      )
      const fixedTime = new Date(1_000)
      utimesSync(currentPath, fixedTime, fixedTime)
      await makeOpenClaudeService().refreshManagedScripts()
      expect(statSync(currentPath).mtimeMs).toBe(fixedTime.getTime())
    } finally {
      homedirMock.mockImplementation(() => process.env.HOME ?? tmpdir())
      rmSync(home, { recursive: true, force: true })
    }
  })
})
