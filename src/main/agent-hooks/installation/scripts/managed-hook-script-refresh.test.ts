import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as CodexHookHashLookup from '../../../codex/trust/hooks/codex-hook-hash-lookup'
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
import { join } from 'node:path'
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

vi.mock('../../../codex/trust/hooks/codex-hook-hash-lookup', async (importOriginal) => ({
  ...(await importOriginal<typeof CodexHookHashLookup>()),
  resolveCodexHookAnswerForLaunch: async () =>
    (
      await import('../../../codex/hooks/installation/hook-service-test-harness')
    ).codexHookAnswerForTests()
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
import { ClaudeHookService } from '../../../claude/hook-service'

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
})
