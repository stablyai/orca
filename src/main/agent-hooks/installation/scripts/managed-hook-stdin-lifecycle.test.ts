// POSIX hooks drain before exit; Windows missing-context hooks may exit without owning stdin.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as CodexHookHashLookup from '../../../codex/trust/hooks/codex-hook-hash-lookup'
import { spawnProcess } from '@orca/process-host'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type * as osModule from 'node:os'
import type * as NativeHookExecutableModule from '../commands/windows-native-hook-executable'

let isolatedUserDataDir = ''
let previousUserDataPath: string | undefined

beforeEach(() => {
  vi.stubEnv('GROK_HOME', undefined)
  vi.stubEnv('KIMI_CODE_HOME', undefined)
  vi.stubEnv('COPILOT_HOME', undefined)
  vi.stubEnv('KIRO_HOME', undefined)
  vi.stubEnv('XDG_CONFIG_HOME', undefined)
  previousUserDataPath = process.env.ORCA_USER_DATA_PATH
  isolatedUserDataDir = mkdtempSync(join(tmpdir(), 'orca-hook-stdin-user-data-'))
  // Isolate managed-script resolution so inherited user-data paths cannot target live hooks.
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

const { homedirMock, bundledHook } = vi.hoisted(() => {
  const bundledHook: { path: string | null } = { path: null }
  return { homedirMock: vi.fn<() => string>(), bundledHook }
})

// Test the real built executable without packaged resource lookup.
vi.mock('../commands/windows-native-hook-executable', async (importOriginal) => ({
  ...(await importOriginal<typeof NativeHookExecutableModule>()),
  resolveBundledWindowsNativeHookExecutable: () => bundledHook.path
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

import '../../../antigravity/hook-service'
import { ClaudeHookService } from '../../../claude/hook-service'
import '../../../claude/hook-settings'
import '../../../codex/hooks/installation/hook-service'
import '../../../codex/hooks/installation/codex-hook-service-implementation'
import '../../../command-code/hook-service'
import '../../../copilot/hook-service'
import '../../../cursor/hook-service'
import '../../../devin/hook-service'
import '../../../droid/hook-service'
import '../../../gemini/hook-service'
import '../../../grok/hook-service'
import '../../../kimi/hook-service'

import '../../../openclaude/hook-service'

import { POSIX_HOOK_STDIN_READER } from './hook-stdin-contract'
import '../commands/runtime-home-hook-command'
import '../remote/testing/agent-hook-memory-sftp.test-fixture'
import { findGitBash } from '../commands/testing/windows-git-bash-path.test-fixture'
import {
  WINDOWS_POWERSHELL_WARM_UP_TIMEOUT_MS,
  warmWindowsEncodedPowerShell
} from '../commands/testing/windows-powershell-warm-up.test-fixture'
import {
  buildWindowsNativeHookExecutable,
  WINDOWS_NATIVE_HOOK_BUILD_TIMEOUT_MS
} from '../commands/testing/windows-native-hook-exe.test-fixture'

const REMOTE_HOME = '/home/dev'
const LARGE_PAYLOAD = Buffer.alloc(1_000_000, 'x')

// Seed the user's usual AutoRun target so profile redirection cannot introduce cmd stderr noise.
function seedCmdAutoRunTarget(profileDir: string): void {
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, '.cmd_aliases.cmd'), '@echo off\r\n', 'utf8')
}

type HookRun = {
  exitCode: number | null
  stdinErrors: NodeJS.ErrnoException[]
  stderr: string
  stdout: string
}

function runHookProcess(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  // An open, unwritten pipe exposes read-to-EOF hangs outside an Orca pane.
  stdin: 'close' | 'abandon' = 'close'
): Promise<HookRun> {
  return new Promise((resolve, reject) => {
    const child = spawnProcess({
      program: executable,
      args,
      env,
      stdio: 'pipe'
    })
    const stdinErrors: NodeJS.ErrnoException[] = []
    let stderr = ''
    let stdout = ''
    const timeout = setTimeout(() => {
      child.stdin.destroy()
      child.kill('SIGKILL')
      reject(
        new Error(
          `hook did not finish with stdin ${stdin}d: ${executable} ${args.join(' ').slice(0, 200)}`
        )
      )
    }, 10_000)
    child.on('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.stdin.on('error', (error: NodeJS.ErrnoException) => stdinErrors.push(error))
    child.on('close', (exitCode) => {
      clearTimeout(timeout)
      resolve({ exitCode, stdinErrors, stderr, stdout })
    })
    if (stdin === 'close') {
      child.stdin.end(LARGE_PAYLOAD)
    }
  })
}

function hookEnvironment(extraEnv: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('ORCA_'))
  )
  return {
    ...env,
    HOME: REMOTE_HOME,
    ORCA_AGENT_HOOK_ENDPOINT: '',
    ...extraEnv
  }
}

describe('Windows managed hook stdin structure', () => {
  beforeAll(async () => {
    if (process.platform === 'win32') {
      await warmWindowsEncodedPowerShell(hookEnvironment())
    }
  }, WINDOWS_POWERSHELL_WARM_UP_TIMEOUT_MS)

  // Command-shape assertions missed conhost discarding the consumer's JSON output.
  it.skipIf(process.platform !== 'win32').each([
    { form: 'claude-hook.cmd', bundled: false },
    { form: 'orca-agent-hook.exe claude', bundled: true }
  ])(
    'emits parseable JSON on stdout from the registered Claude hook command ($form), through cmd.exe and Git Bash',
    async ({ form, bundled }) => {
      const home = mkdtempSync(join(tmpdir(), 'orca-hook-stdout-json-'))
      homedirMock.mockReturnValue(home)
      const absentProfile = join(home, 'absent')
      seedCmdAutoRunTarget(home)
      seedCmdAutoRunTarget(absentProfile)
      try {
        bundledHook.path = bundled ? buildWindowsNativeHookExecutable() : null
        expect(new ClaudeHookService().install().state).toBe('installed')
        const settings = JSON.parse(
          readFileSync(join(home, '.claude', 'settings.json'), 'utf8')
        ) as { hooks: Record<string, { hooks: { command: string; args?: string[] }[] }[]> }
        const entry = settings.hooks.PreToolUse[0].hooks[0]
        expect(entry.args).toBeUndefined()
        expect(entry.command.endsWith(form)).toBe(true)

        // MSYS rewrites paths and switches, so exercise both shells.
        const gitBash = findGitBash()
        const shells = [
          { name: 'cmd.exe', executable: 'cmd.exe', args: ['/d', '/c', entry.command] },
          { name: 'Git Bash', executable: gitBash, args: ['-c', entry.command] }
        ]
        const environments = [
          { name: 'no Orca env', env: hookEnvironment({ USERPROFILE: home }) },
          {
            name: 'Orca env with dead listener',
            env: hookEnvironment({
              USERPROFILE: home,
              ORCA_AGENT_HOOK_PORT: '59999',
              ORCA_AGENT_HOOK_TOKEN: 'token',
              ORCA_PANE_KEY: 'tab:leaf'
            })
          },
          {
            // Profile redirection hides runtime-resolved scripts; direct launchers retain their absolute path.
            name: 'missing managed script',
            env: hookEnvironment({ USERPROFILE: absentProfile })
          }
        ]
        for (const shell of shells) {
          for (const environment of environments) {
            const label = `${shell.name} / ${environment.name}`
            const result = await runHookProcess(shell.executable, shell.args, environment.env)
            expect(result.exitCode, `${label} exit code`).toBe(0)
            expect(result.stderr, `${label} stderr`).toBe('')
            expect(() => JSON.parse(result.stdout.trim()), `${label} stdout is JSON`).not.toThrow()
            expect(JSON.parse(result.stdout.trim()), `${label} stdout`).toEqual({})
          }
          if (bundled) {
            const abandoned = await runHookProcess(
              shell.executable,
              shell.args,
              environments[0].env,
              'abandon'
            )
            expect(abandoned.exitCode, `${shell.name} abandoned-stdin exit code`).toBe(0)
          }
        }
      } finally {
        bundledHook.path = null
        homedirMock.mockImplementation(() => process.env.HOME ?? tmpdir())
        rmSync(home, { recursive: true, force: true })
      }
    },
    // Allow cold executable builds and six shell launches under load.
    WINDOWS_NATIVE_HOOK_BUILD_TIMEOUT_MS
  )
})

describe.skipIf(process.platform === 'win32')('managed hook stdin lifecycle', () => {
  // Exit zero does not prove stdin was consumed; measure captured bytes.
  it.each([
    ['empty PATH', ''],
    // NixOS may lack /bin/cat; exercise the shell's default PATH.
    ['PATH without coreutils', '/nonexistent'],
    ['PATH whose first cat is a decoy', '']
  ])('captures the whole payload with %s', async (label, pathValue) => {
    const decoyDir = mkdtempSync(join(tmpdir(), 'orca-hook-stdin-decoy-'))
    try {
      let effectivePath = pathValue
      if (label === 'PATH whose first cat is a decoy') {
        const decoy = join(decoyDir, 'cat')
        writeFileSync(decoy, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
        effectivePath = decoyDir
      }
      const result = await runHookProcess(
        '/bin/sh',
        ['-c', `payload=$(${POSIX_HOOK_STDIN_READER}); printf '%s' "${'${#payload}'}"`],
        { ...hookEnvironment(), PATH: effectivePath }
      )
      expect(result.exitCode, `${label} exit code`).toBe(0)
      expect(result.stdinErrors, `${label} stdin errors`).toHaveLength(0)
      expect(result.stdout, `${label} captured bytes`).toBe(String(LARGE_PAYLOAD.length))
    } finally {
      rmSync(decoyDir, { recursive: true, force: true })
    }
  })
})
