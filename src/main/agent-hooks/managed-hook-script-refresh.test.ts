import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as CodexHookHashLookup from '../codex/codex-hook-hash-lookup'
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
import { spawnSync } from 'node:child_process'
import { join, sep } from 'node:path'
import type * as osModule from 'node:os'

let isolatedUserDataDir = ''
let previousUserDataPath: string | undefined

beforeEach(() => {
  vi.stubEnv('GROK_HOME', undefined)
  vi.stubEnv('KIMI_CODE_HOME', undefined)
  vi.stubEnv('COPILOT_HOME', undefined)
  vi.stubEnv('KIRO_HOME', undefined)
  vi.stubEnv('XDG_CONFIG_HOME', undefined)
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
  vi.unstubAllEnvs()
})

const { homedirMock } = vi.hoisted(() => ({
  homedirMock: vi.fn<() => string>()
}))

vi.mock('../codex/codex-hook-hash-lookup', async (importOriginal) => ({
  ...(await importOriginal<typeof CodexHookHashLookup>()),
  resolveCodexHookAnswerForLaunch: async () =>
    (await import('../codex/hook-service-test-harness')).codexHookAnswerForTests()
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
import { ClaudeHookService } from '../claude/hook-service'

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
      // Simulate a prior install whose CLI and provider config directory are now absent.
      const hooksDir = join(home, '.orca', 'agent-hooks')
      mkdirSync(hooksDir, { recursive: true })
      writeFileSync(join(hooksDir, 'claude-hook.cmd'), STALE_WINDOWS_HOOK)

      await withPlatform('win32', () => new ClaudeHookService().refreshManagedScripts())

      const refreshed = readFileSync(join(hooksDir, 'claude-hook.cmd'), 'utf8')
      expect(refreshed).toContain('if "%ORCA_AGENT_HOOK_PORT%"=="" exit /b 0')
      expect(refreshed).not.toContain('if "%ORCA_AGENT_HOOK_PORT%"=="" goto')
      expect(existsSync(join(home, '.claude'))).toBe(false)
      expect(existsSync(join(hooksDir, 'claude-statusline.cmd'))).toBe(false)
    } finally {
      homedirMock.mockImplementation(() => process.env.HOME ?? tmpdir())
      rmSync(home, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')(
    'refreshes existing POSIX hook and statusline locale handling without a CLI config',
    async () => {
      const home = mkdtempSync(join(tmpdir(), 'orca-hook-locale-refresh-'))
      homedirMock.mockReturnValue(home)
      try {
        const hooksDir = join(home, '.orca', 'agent-hooks')
        mkdirSync(hooksDir, { recursive: true })
        for (const name of ['claude-hook.sh', 'claude-statusline.sh']) {
          writeFileSync(join(hooksDir, name), '#!/bin/sh\ncurl --connect-timeout 0.5\n')
        }
        await new ClaudeHookService().refreshManagedScripts()
        for (const name of ['claude-hook.sh', 'claude-statusline.sh']) {
          const observed = join(home, `${name}.locale`)
          const result = spawnSync(
            '/bin/sh',
            [
              '-c',
              'curl() { printf "%s|%s" "$LC_ALL" "$LC_NUMERIC" > "$ORCA_TEST_CURL_LOCALE"; command -p cat >/dev/null; }; . "$1"',
              'hook',
              join(hooksDir, name)
            ],
            {
              input: '{"hook_event_name":"Stop","rate_limits":{},"total_duration_ms":1000}',
              encoding: 'utf8',
              timeout: 5_000,
              env: {
                ...process.env,
                LC_ALL: 'de_DE.UTF-8',
                LC_NUMERIC: 'de_DE.UTF-8',
                TMPDIR: home,
                CLAUDE_JOB_DIR: '',
                ORCA_AGENT_HOOK_ENDPOINT: '',
                ORCA_AGENT_HOOK_PORT: '1',
                ORCA_AGENT_HOOK_TOKEN: 'test-token',
                ORCA_PANE_KEY: 'pane-1',
                ORCA_TEST_CURL_LOCALE: observed
              }
            }
          )
          expect(result.error, name).toBeUndefined()
          expect(result.status, name).toBe(0)
          expect(existsSync(observed), `${name} delivered to curl`).toBe(true)
          expect(readFileSync(observed, 'utf8'), name).toBe('|C')
          expect(statSync(join(hooksDir, name)).mode & 0o777).toBe(0o755)
        }
        expect(existsSync(join(home, '.claude'))).toBe(false)
        expect(readdirSync(hooksDir).sort()).toEqual(['claude-hook.sh', 'claude-statusline.sh'])
      } finally {
        homedirMock.mockImplementation(() => process.env.HOME ?? tmpdir())
        rmSync(home, { recursive: true, force: true })
      }
    }
  )

  it('restores every installed shared launcher through its registered refresher', async () => {
    const home = mkdtempSync(join(tmpdir(), 'orca-hook-refresh-coverage-'))
    homedirMock.mockReturnValue(home)
    const previousGrokHome = process.env.GROK_HOME
    const previousKimiHome = process.env.KIMI_CODE_HOME
    const previousXdgConfigHome = process.env.XDG_CONFIG_HOME
    delete process.env.GROK_HOME
    delete process.env.KIMI_CODE_HOME
    delete process.env.XDG_CONFIG_HOME
    try {
      await withPlatform('win32', async () => {
        for (const [, install] of MANAGED_AGENT_HOOK_INSTALLERS) {
          await install()
        }
      })
      const hooksDir = join(home, '.orca', 'agent-hooks')
      const files = readdirSync(hooksDir)
      expect(files.length).toBeGreaterThan(0)
      const installed = new Map(
        readdirSync(hooksDir, { recursive: true, encoding: 'utf8' })
          .filter((file) => statSync(join(hooksDir, file)).isFile())
          .map((file) => [file, readFileSync(join(hooksDir, file))])
      )
      const homeEntries = readdirSync(home, { recursive: true, encoding: 'utf8' }).sort()
      const configs = new Map(
        homeEntries
          .filter((file) => !file.startsWith(join('.orca', 'agent-hooks') + sep))
          .filter((file) => statSync(join(home, file)).isFile())
          .map((file) => [file, readFileSync(join(home, file))])
      )
      for (const [file] of installed) {
        if (/\.(?:cmd|ps1|sh|cjs|exe)$/.test(file)) {
          writeFileSync(join(hooksDir, file), 'stale')
        }
      }
      await withPlatform('win32', async () => {
        for (const [agent, refresh] of MANAGED_AGENT_HOOK_SCRIPT_REFRESHERS) {
          await expect(refresh(), `${agent} refresh on installed home`).resolves.toBeUndefined()
        }
      })
      expect(readdirSync(hooksDir).sort()).toEqual([...files].sort())
      for (const [file, content] of installed) {
        expect(readFileSync(join(hooksDir, file)), `${file} restored`).toEqual(content)
      }
      expect(readdirSync(home, { recursive: true, encoding: 'utf8' }).sort()).toEqual(homeEntries)
      for (const [file, content] of configs) {
        expect(readFileSync(join(home, file)), `${file} config preserved`).toEqual(content)
      }
      const refresherAgents = MANAGED_AGENT_HOOK_SCRIPT_REFRESHERS.map(([agent]) => agent)
      for (const file of files) {
        expect(
          refresherAgents.some((agent) => file.startsWith(`${agent}-`)),
          `${file} is written to ~/.orca/agent-hooks but no refresher owns it`
        ).toBe(true)
      }
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
      if (previousXdgConfigHome === undefined) {
        delete process.env.XDG_CONFIG_HOME
      } else {
        process.env.XDG_CONFIG_HOME = previousXdgConfigHome
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
      expect(readdirSync(home)).toEqual([])
    } finally {
      homedirMock.mockImplementation(() => process.env.HOME ?? tmpdir())
      rmSync(home, { recursive: true, force: true })
    }
  })
})
