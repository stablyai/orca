// Why (#11549 aftermath): a CLI that falls off PATH keeps its user-wide config invoking
// Orca's script while the presence gate skips install() forever. These tests pin the
// repair — existing scripts come current, missing ones are never created.
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
import { createHash } from 'node:crypto'
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

// Why: stands in for asking a real Codex for its hook hashes, as the grant stub once did.
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
import { MANAGED_SCRIPT_GENERATION, MANAGED_SCRIPT_LEDGER_FILE } from './managed-script-generation'

// Digest of every shared launcher script each platform's installers write, for the generation
// those bytes belong to. A failure here means a managed script changed: bump
// MANAGED_SCRIPT_GENERATION in managed-script-generation.ts and paste the new digests.
const MANAGED_SCRIPT_DIGESTS = {
  generation: 1,
  darwin: '0931080d8b67f65126ea3391754780987398d2273d586003d49d36c59695f9e1',
  linux: '0931080d8b67f65126ea3391754780987398d2273d586003d49d36c59695f9e1',
  win32: 'e229f76bba6ce6790f6daa4235d8109220be26069b5c7a090a99424abb074838'
}

const AGENT_HOME_ENV = ['GROK_HOME', 'KIMI_CODE_HOME', 'XDG_CONFIG_HOME'] as const

async function installedScriptsDigest(platform: NodeJS.Platform): Promise<string> {
  const home = mkdtempSync(join(tmpdir(), 'orca-hook-digest-'))
  homedirMock.mockReturnValue(home)
  const savedEnv = AGENT_HOME_ENV.map((key) => [key, process.env[key]] as const)
  for (const key of AGENT_HOME_ENV) {
    delete process.env[key]
  }
  try {
    await withPlatform(platform, async () => {
      for (const [, install] of MANAGED_AGENT_HOOK_INSTALLERS) {
        await install()
      }
    })
    const hooksDir = join(home, '.orca', 'agent-hooks')
    const hash = createHash('sha256')
    // Why top level only: subdirectories hold per-run state (grok-owners/), not scripts.
    const files = readdirSync(hooksDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name !== MANAGED_SCRIPT_LEDGER_FILE)
      .map((entry) => entry.name)
      .sort()
    for (const file of files) {
      // Why: scripts may name the home, userData and Node binary (also inside PowerShell's
      // base64 -EncodedCommand), which differ per run and per machine.
      const text = readFileSync(join(hooksDir, file), 'utf8')
        .replaceAll(/-EncodedCommand ([A-Za-z0-9+/=]+)/g, (_match, encoded: string) =>
          Buffer.from(encoded, 'base64').toString('utf16le')
        )
        .replaceAll(home, '<home>')
        .replaceAll(isolatedUserDataDir, '<userData>')
        .replaceAll(process.execPath, '<node>')
      hash.update(`${file}\0${text}\0`)
    }
    return hash.digest('hex')
  } finally {
    homedirMock.mockImplementation(() => process.env.HOME ?? tmpdir())
    for (const [key, value] of savedEnv) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
    rmSync(home, { recursive: true, force: true })
  }
}

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
    const previousXdgConfigHome = process.env.XDG_CONFIG_HOME
    delete process.env.GROK_HOME
    delete process.env.KIMI_CODE_HOME
    delete process.env.XDG_CONFIG_HOME
    try {
      // Why awaited: the Codex installer waits for Codex's hook hashes before it writes.
      await withPlatform('win32', async () => {
        for (const [, install] of MANAGED_AGENT_HOOK_INSTALLERS) {
          await install()
        }
      })
      const hooksDir = join(home, '.orca', 'agent-hooks')
      const files = readdirSync(hooksDir).filter((file) => file !== MANAGED_SCRIPT_LEDGER_FILE)
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
      // Why: a refresh pass on a machine with no prior installs must be a strict no-op.
      expect(readdirSync(home)).toEqual([])
    } finally {
      homedirMock.mockImplementation(() => process.env.HOME ?? tmpdir())
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('managed script generation', () => {
  // Why not on Windows: the pin emulates each platform, and a Windows host's path module would
  // write backslash paths no other host produces.
  it.skipIf(process.platform === 'win32')(
    'pins the generation to the bytes the installers write',
    async () => {
      const actual = { generation: MANAGED_SCRIPT_GENERATION, darwin: '', linux: '', win32: '' }
      for (const platform of ['darwin', 'linux', 'win32'] as const) {
        actual[platform] = await installedScriptsDigest(platform)
      }
      expect(actual).toEqual(MANAGED_SCRIPT_DIGESTS)
    }
  )
})
