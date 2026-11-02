// Check generated .cmd scripts on every host; Antigravity uses a separate bounded Node stdin reader.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as CodexHookHashLookup from '../codex/codex-hook-hash-lookup'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as osModule from 'node:os'

let isolatedUserDataDir = ''
let previousUserDataPath: string | undefined

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

import { ClaudeHookService } from '../claude/hook-service'
import { CodexHookService } from '../codex/hook-service'
import { CommandCodeHookService } from '../command-code/hook-service'
import { CursorHookService } from '../cursor/hook-service'
import { DevinHookService } from '../devin/hook-service'
import { DroidHookService } from '../droid/hook-service'
import { GeminiHookService } from '../gemini/hook-service'
import { GrokHookService } from '../grok/hook-service'
import { openClaudeHookService } from '../openclaude/hook-service'

// Only batch scripts belong here; PowerShell-native hooks use their interpreter directly.
const BATCH_SCRIPT_INSTALLERS = [
  { agent: 'claude', install: () => new ClaudeHookService().install() },
  { agent: 'openclaude', install: () => openClaudeHookService.install() },
  { agent: 'codex', install: () => new CodexHookService().install() },
  { agent: 'command-code', install: () => new CommandCodeHookService().install() },
  { agent: 'cursor', install: () => new CursorHookService().install() },
  { agent: 'devin', install: () => new DevinHookService().install() },
  { agent: 'droid', install: () => new DroidHookService().install() },
  { agent: 'gemini', install: () => new GeminiHookService().install() },
  { agent: 'grok', install: () => new GrokHookService().install() }
] as const

// Keep the platform override pinned across asynchronous installers.
async function withPlatform<T>(platform: NodeJS.Platform, run: () => T | Promise<T>): Promise<T> {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  try {
    return await run()
  } finally {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  }
}

describe('Windows managed hook post interpreter', () => {
  let home = ''

  beforeEach(() => {
    previousUserDataPath = process.env.ORCA_USER_DATA_PATH
    isolatedUserDataDir = mkdtempSync(join(tmpdir(), 'orca-hook-interpreter-user-data-'))
    // Isolate managed-script resolution so tests cannot rewrite live Codex hooks.
    process.env.ORCA_USER_DATA_PATH = isolatedUserDataDir
    home = mkdtempSync(join(tmpdir(), 'orca-hook-interpreter-'))
    homedirMock.mockReturnValue(home)
  })

  afterEach(() => {
    if (previousUserDataPath === undefined) {
      delete process.env.ORCA_USER_DATA_PATH
    } else {
      process.env.ORCA_USER_DATA_PATH = previousUserDataPath
    }
    rmSync(isolatedUserDataDir, { recursive: true, force: true })
    homedirMock.mockImplementation(() => process.env.HOME ?? tmpdir())
    rmSync(home, { recursive: true, force: true })
    home = ''
  })

  it('posts through curl.exe from every managed batch script, spawning no interpreter', async () => {
    const scripts = await withPlatform('win32', async () => {
      for (const entry of BATCH_SCRIPT_INSTALLERS) {
        expect((await entry.install()).state, `${entry.agent} install status`).toBe('installed')
      }
      const hooksDir = join(home, '.orca', 'agent-hooks')
      return readdirSync(hooksDir)
        .filter((name) => name.endsWith('.cmd'))
        .map((name) => ({ name, body: readFileSync(join(hooksDir, name), 'utf8') }))
    })

    expect(scripts.length).toBeGreaterThanOrEqual(BATCH_SCRIPT_INSTALLERS.length)

    // Inspect every script before filtering so a lost POST cannot hide an interpreter regression.
    for (const script of scripts) {
      // curl avoids PowerShell startup and UTF-8 recoding.
      expect(script.body, `${script.name} must not spawn an interpreter`).not.toMatch(
        /powershell(\.exe)?/i
      )
    }

    const isWrapper = (body: string): boolean => body.includes('%~dp0')
    const posts = (body: string): boolean => body.includes('127.0.0.1:%ORCA_AGENT_HOOK_PORT%')

    expect(
      scripts.filter((s) => !isWrapper(s.body) && !posts(s.body)).map((s) => s.name),
      'every non-wrapper script must post to the hook port'
    ).toEqual([])

    const posting = scripts.filter((script) => posts(script.body))
    expect(posting.length).toBeGreaterThanOrEqual(BATCH_SCRIPT_INSTALLERS.length)

    for (const script of posting) {
      // A repo-local curl.exe must not intercept hook payloads.
      expect(script.body, `${script.name} must post through curl.exe`).toContain(
        '"%SystemRoot%\\System32\\curl.exe"'
      )
    }

    // stdin avoids EDR command-length limits; statusline payloads use temporary files.
    for (const script of posting.filter((s) => s.body.includes('/hook/'))) {
      expect(script.body, `${script.name} must pipe the payload via stdin`).toContain(
        '--data-urlencode "payload@-"'
      )
    }
  })
})
