// POSIX hooks drain before exit; Windows missing-context hooks may exit without owning stdin.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as CodexHookHashLookup from '../codex/codex-hook-hash-lookup'
import { runProcess, spawnProcess } from '@orca/process-host'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SFTPWrapper } from 'ssh2'
import type * as osModule from 'node:os'
import type * as NativeHookExecutableModule from './windows-native-hook-executable'

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
vi.mock('./windows-native-hook-executable', async (importOriginal) => ({
  ...(await importOriginal<typeof NativeHookExecutableModule>()),
  resolveBundledWindowsNativeHookExecutable: () => bundledHook.path
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

import { AntigravityHookService } from '../antigravity/hook-service'
import { ClaudeHookService } from '../claude/hook-service'
import { getRemoteManagedCommand } from '../claude/hook-settings'
import { CodexHookService } from '../codex/hook-service'
import { CommandCodeHookService } from '../command-code/hook-service'
import { CopilotHookService } from '../copilot/hook-service'
import { CursorHookService } from '../cursor/hook-service'
import { DevinHookService } from '../devin/hook-service'
import { DroidHookService } from '../droid/hook-service'
import { GeminiHookService } from '../gemini/hook-service'
import { GrokHookService } from '../grok/hook-service'
import { KimiHookService } from '../kimi/hook-service'

import { openClaudeHookService } from '../openclaude/hook-service'
import { wrapPosixHookCommand, wrapWindowsHookCommand } from './installer-utils'
import {
  POSIX_HOOK_JSON_STDIN_PRELUDE,
  POSIX_HOOK_JSON_STDIN_READER,
  POSIX_HOOK_STDIN_READER,
  WINDOWS_POWERSHELL_HOOK_ENVIRONMENT_GUARD
} from './hook-stdin-contract'
import { wrapRuntimeHomeHookCommand } from './runtime-home-hook-command'
import { createAgentHookMemorySftp } from './agent-hook-memory-sftp.test-fixture'
import { findGitBash } from './windows-git-bash-path.test-fixture'
import {
  buildWindowsNativeHookExecutable,
  WINDOWS_NATIVE_HOOK_BUILD_TIMEOUT_MS
} from './windows-native-hook-exe.test-fixture'

function decodeEncodedPowerShellCommand(command: string): string {
  const encoded = command.match(/-EncodedCommand\s+(\S+)/)
  expect(encoded, 'launcher carries an encoded command').not.toBeNull()
  return Buffer.from(encoded![1], 'base64').toString('utf16le')
}

const REMOTE_HOME = '/home/dev'
// Windows broken-pipe errors vary with pipe and process teardown ordering.
const WRITER_BROKEN_BY_EARLY_EXIT = ['EPIPE', 'ECONNRESET', 'EOF']
const LARGE_PAYLOAD = Buffer.alloc(1_000_000, 'x')

// Seed the user's usual AutoRun target so profile redirection cannot introduce cmd stderr noise.
function seedCmdAutoRunTarget(profileDir: string): void {
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, '.cmd_aliases.cmd'), '@echo off\r\n', 'utf8')
}
const REMOTE_INSTALLERS = [
  {
    agent: 'antigravity',
    install: (sftp: SFTPWrapper) => new AntigravityHookService().installRemote(sftp, REMOTE_HOME)
  },
  {
    agent: 'claude',
    install: (sftp: SFTPWrapper) => new ClaudeHookService().installRemote(sftp, REMOTE_HOME)
  },
  {
    agent: 'openclaude',
    install: (sftp: SFTPWrapper) => openClaudeHookService.installRemote(sftp, REMOTE_HOME)
  },
  {
    agent: 'codex',
    install: (sftp: SFTPWrapper) => new CodexHookService().installRemote(sftp, REMOTE_HOME)
  },
  {
    agent: 'command-code',
    install: (sftp: SFTPWrapper) => new CommandCodeHookService().installRemote(sftp, REMOTE_HOME)
  },
  {
    agent: 'copilot',
    install: (sftp: SFTPWrapper) => new CopilotHookService().installRemote(sftp, REMOTE_HOME)
  },
  {
    agent: 'cursor',
    install: (sftp: SFTPWrapper) => new CursorHookService().installRemote(sftp, REMOTE_HOME)
  },
  {
    agent: 'devin',
    install: (sftp: SFTPWrapper) => new DevinHookService().installRemote(sftp, REMOTE_HOME)
  },
  {
    agent: 'droid',
    install: (sftp: SFTPWrapper) => new DroidHookService().installRemote(sftp, REMOTE_HOME)
  },
  {
    agent: 'gemini',
    install: (sftp: SFTPWrapper) => new GeminiHookService().installRemote(sftp, REMOTE_HOME)
  },
  {
    agent: 'grok',
    install: (sftp: SFTPWrapper) => new GrokHookService().installRemote(sftp, REMOTE_HOME)
  },
  {
    agent: 'kimi',
    install: (sftp: SFTPWrapper) => new KimiHookService().installRemote(sftp, REMOTE_HOME)
  }
] as const

const LOCAL_INSTALLERS = [
  { agent: 'antigravity', install: () => new AntigravityHookService().install() },
  { agent: 'claude', install: () => new ClaudeHookService().install() },
  { agent: 'openclaude', install: () => openClaudeHookService.install() },
  { agent: 'codex', install: () => new CodexHookService().install() },
  { agent: 'command-code', install: () => new CommandCodeHookService().install() },
  { agent: 'copilot', install: () => new CopilotHookService().install() },
  { agent: 'cursor', install: () => new CursorHookService().install() },
  { agent: 'devin', install: () => new DevinHookService().install() },
  { agent: 'droid', install: () => new DroidHookService().install() },
  { agent: 'gemini', install: () => new GeminiHookService().install() },
  { agent: 'grok', install: () => new GrokHookService().install() },
  { agent: 'kimi', install: () => new KimiHookService().install() }
] as const

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

function runPosixHook(command: string, extraEnv: NodeJS.ProcessEnv = {}): Promise<HookRun> {
  return runHookProcess('/bin/sh', ['-c', command], hookEnvironment(extraEnv))
}

async function generatePosixScripts(onlyAgent?: string): Promise<Map<string, string>> {
  const scripts = new Map<string, string>()
  for (const entry of REMOTE_INSTALLERS) {
    if (onlyAgent && entry.agent !== onlyAgent) {
      continue
    }
    const memory = createAgentHookMemorySftp()
    const status = await entry.install(memory.sftp)
    expect(status.state, `${entry.agent} install status`).toBe('installed')
    const generated = [...memory.fs.files.entries()].filter(
      ([path]) => path.includes('/.orca/agent-hooks/') && path.endsWith('.sh')
    )
    expect(generated.length, `${entry.agent} generated scripts`).toBeGreaterThan(0)
    for (const [path, script] of generated) {
      scripts.set(`${entry.agent} ${path.split('/').pop()}`, script)
    }
  }
  return scripts
}

// Keep the platform override pinned across asynchronous installers.
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

describe('Windows managed hook stdin structure', () => {
  // A fresh runner's first encoded-PowerShell launch took 5-15s; the per-hook bound detects stdin hangs, not cold start.
  beforeAll(async () => {
    if (process.platform !== 'win32') {
      return
    }
    const warm = await runProcess({
      program: 'cmd.exe',
      args: ['/d', '/c', wrapWindowsHookCommand('C:\\missing\\orca-hook.cmd')],
      env: hookEnvironment(),
      timeoutMs: 55_000
    })
    expect(warm, 'encoded PowerShell warm-up').toMatchObject({ code: 0, timedOut: false })
  }, 60_000)

  it('places missing-context guards before Windows stdin readers', async () => {
    const home = mkdtempSync(join(tmpdir(), 'orca-hook-stdin-windows-'))
    homedirMock.mockReturnValue(home)
    seedCmdAutoRunTarget(home)
    const previousGrokHome = process.env.GROK_HOME
    const previousKimiHome = process.env.KIMI_CODE_HOME
    delete process.env.GROK_HOME
    delete process.env.KIMI_CODE_HOME
    try {
      await withPlatform('win32', async () => {
        for (const entry of LOCAL_INSTALLERS) {
          expect((await entry.install()).state, `${entry.agent} install status`).toBe('installed')
        }
      })
      const hooksDir = join(home, '.orca', 'agent-hooks')
      const fileNames = readdirSync(hooksDir)
      const mainBatchScripts = fileNames.filter(
        (name) => name.endsWith('-hook.cmd') && !name.startsWith('antigravity-')
      )
      mainBatchScripts.push('antigravity-hook.cmd')
      expect(mainBatchScripts).toHaveLength(12)
      for (const fileName of mainBatchScripts) {
        const script = readFileSync(join(hooksDir, fileName), 'utf8')
        expect(script, `${fileName} port guard`).toContain(
          'if "%ORCA_AGENT_HOOK_PORT%"=="" exit /b 0'
        )
        expect(script, `${fileName} token guard`).toContain(
          'if "%ORCA_AGENT_HOOK_TOKEN%"=="" exit /b 0'
        )
        expect(script, `${fileName} pane guard`).toContain('if "%ORCA_PANE_KEY%"=="" exit /b 0')
        // A caller may hold stdin open, so no guard or skip may park in the more.com drain (#24907).
        expect(script, `${fileName} no guard may route to the more.com drain`).not.toMatch(
          /goto :?orca_agent_hook_drain_stdin/
        )
        if (fileName === 'antigravity-hook.cmd') {
          expect(script).not.toContain('more.com')
          expect(script).toContain('antigravity-hook-post.cjs')
        }
      }

      // Missing-script launchers must answer gates before guarding, then guard before ReadToEnd.
      for (const [name, command] of [
        [
          'wrapWindowsHookCommand',
          wrapWindowsHookCommand('C:\\missing\\orca-hook.cmd', {}, { fallbackStdout: '{}' })
        ],
        [
          'wrapRuntimeHomeHookCommand',
          wrapRuntimeHomeHookCommand('missing-orca-hook', { neutralJsonWhenMissing: true })
        ]
      ] as const) {
        const decoded = decodeEncodedPowerShellCommand(command)
        expect(decoded, `${name} decoded`).toContain(WINDOWS_POWERSHELL_HOOK_ENVIRONMENT_GUARD)
        expect(
          decoded.indexOf("Write-Output '{}'"),
          `${name} response exists`
        ).toBeGreaterThanOrEqual(0)
        expect(decoded.indexOf("Write-Output '{}'"), `${name} answers first`).toBeLessThan(
          decoded.indexOf(WINDOWS_POWERSHELL_HOOK_ENVIRONMENT_GUARD)
        )
        expect(
          decoded.indexOf(WINDOWS_POWERSHELL_HOOK_ENVIRONMENT_GUARD),
          `${name} guards before owning stdin`
        ).toBeLessThan(decoded.indexOf('[Console]::In.ReadToEnd()'))
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

  it.skipIf(process.platform !== 'win32')(
    'exits 0 for every local script and missing-script launcher, dropping stdin only without Orca env',
    async () => {
      const home = mkdtempSync(join(tmpdir(), 'orca-hook-stdin-windows-live-'))
      homedirMock.mockReturnValue(home)
      seedCmdAutoRunTarget(home)
      try {
        const gitBash = findGitBash()
        for (const entry of LOCAL_INSTALLERS) {
          expect((await entry.install()).state, `${entry.agent} install status`).toBe('installed')
        }
        const hooksDir = join(home, '.orca', 'agent-hooks')
        const mainScripts = readdirSync(hooksDir).filter(
          (name) =>
            name === 'antigravity-hook.cmd' ||
            name.endsWith('-hook.ps1') ||
            name.endsWith('-hook.sh') ||
            (name.endsWith('-hook.cmd') && !name.startsWith('antigravity-'))
        )
        expect(mainScripts).toHaveLength(12)
        for (const fileName of mainScripts) {
          const scriptPath = join(hooksDir, fileName)
          const executable = fileName.endsWith('.cmd')
            ? 'cmd.exe'
            : fileName.endsWith('.ps1')
              ? join(
                  process.env.SystemRoot ?? 'C:\\Windows',
                  'System32',
                  'WindowsPowerShell',
                  'v1.0',
                  'powershell.exe'
                )
              : gitBash
          const args = fileName.endsWith('.cmd')
            ? ['/d', '/c', scriptPath]
            : fileName.endsWith('.ps1')
              ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath]
              : [scriptPath]
          const result = await runHookProcess(executable, args, hookEnvironment())
          expect(result.exitCode, `${fileName} exit code`).toBe(0)
          // Missing-context guards exit before reading stdin, so writers may see a broken pipe.
          for (const error of result.stdinErrors) {
            expect(WRITER_BROKEN_BY_EARLY_EXIT, `${fileName} stdin error`).toContain(error.code)
          }
        }

        // In-pane skips must not wait for stdin EOF from a caller that holds it open (#24907).
        const paneEnv = {
          ORCA_AGENT_HOOK_PORT: '59999',
          ORCA_AGENT_HOOK_TOKEN: 'token',
          ORCA_PANE_KEY: 'tab:leaf'
        }
        for (const [fileName, skipEnv] of [
          ['claude-hook-impl.cmd', { DEVIN_PROJECT_DIR: home }],
          ['claude-hook-impl.cmd', { GROK_HOOK_EVENT: 'PreToolUse' }],
          ['claude-hook-impl.cmd', { CURSOR_VERSION: '1.0', CURSOR_PROJECT_DIR: home }],
          ['cursor-hook.cmd', { GROK_HOOK_EVENT: 'PreToolUse' }],
          ['codex-hook.cmd', { CLAUDE_JOB_DIR: home }]
        ] as const) {
          const skipped = await runHookProcess(
            'cmd.exe',
            ['/d', '/c', join(hooksDir, fileName)],
            hookEnvironment({ ...paneEnv, ...skipEnv }),
            'abandon'
          )
          expect(skipped.exitCode, `${fileName} ${Object.keys(skipEnv)[0]} skip`).toBe(0)
        }

        const missingScript = 'C:\\missing\\orca-hook.cmd'
        // Bare .cmd launchers must remain directly spawnable; only interpreter launchers can drain a missing script.
        const launcherCases = [
          {
            name: 'encoded PowerShell',
            executable: 'cmd.exe',
            args: ['/d', '/c', wrapWindowsHookCommand(missingScript)]
          },
          {
            name: 'portable Git Bash launcher',
            executable: gitBash,
            args: ['-lc', wrapRuntimeHomeHookCommand('missing-orca-hook')]
          }
        ]
        for (const launcher of launcherCases) {
          const outside = await runHookProcess(
            launcher.executable,
            launcher.args,
            hookEnvironment()
          )
          expect(outside.exitCode, `${launcher.name} exit code`).toBe(0)
          for (const error of outside.stdinErrors) {
            expect(WRITER_BROKEN_BY_EARLY_EXIT, `${launcher.name} stdin error`).toContain(
              error.code
            )
          }
          const insideAPane = await runHookProcess(
            launcher.executable,
            launcher.args,
            hookEnvironment({
              ORCA_AGENT_HOOK_PORT: '59999',
              ORCA_AGENT_HOOK_TOKEN: 'token',
              ORCA_PANE_KEY: 'tab:leaf'
            })
          )
          expect(insideAPane.exitCode, `${launcher.name} in-pane exit code`).toBe(0)
          expect(insideAPane.stdinErrors, `${launcher.name} in-pane stdin errors`).toHaveLength(0)
          // Closing stdin masks ReadToEnd hangs; an abandoned pipe exposes them.
          const abandoned = await runHookProcess(
            launcher.executable,
            launcher.args,
            hookEnvironment(),
            'abandon'
          )
          expect(abandoned.exitCode, `${launcher.name} abandoned-stdin exit code`).toBe(0)
        }
      } finally {
        homedirMock.mockImplementation(() => process.env.HOME ?? tmpdir())
        rmSync(home, { recursive: true, force: true })
      }
    }
  )

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
  it('emits neutral JSON when the Claude lifecycle script is missing', async () => {
    const command = getRemoteManagedCommand('/home/dev/.orca/agent-hooks/claude-hook.sh')
    const result = await runPosixHook(command)

    expect(result.exitCode).toBe(0)
    expect(result.stdinErrors).toHaveLength(0)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout.trim())).toEqual({})
  })

  it('captures stdin before every possible whole-script success exit', async () => {
    const scripts = await generatePosixScripts()
    for (const [agent, script] of scripts) {
      const captureIndex = Math.max(
        script.indexOf(`payload=$(${POSIX_HOOK_STDIN_READER})`),
        script.indexOf(`payload=$(${POSIX_HOOK_JSON_STDIN_READER})`)
      )
      const firstExitIndex = script.indexOf('exit 0')
      expect(captureIndex, `${agent} payload capture`).toBeGreaterThanOrEqual(0)
      expect(firstExitIndex, `${agent} first success exit`).toBeGreaterThan(captureIndex)
      // The JSON reader needs its variable-setting prelude before capture.
      if (script.includes(POSIX_HOOK_JSON_STDIN_READER)) {
        const prelude = POSIX_HOOK_JSON_STDIN_PRELUDE.join('\n')
        expect(script.indexOf(prelude), `${agent} JSON reader prelude`).toBeGreaterThanOrEqual(0)
        expect(script.indexOf(prelude), `${agent} prelude before capture`).toBeLessThan(
          captureIndex
        )
      }
    }
  })

  it('accepts a large payload across generated hooks without breaking the writer', async () => {
    const scripts = await generatePosixScripts()
    for (const [agent, script] of scripts) {
      const extraEnv = agent.startsWith('command-code')
        ? {
            ORCA_AGENT_HOOK_PORT: '1',
            ORCA_AGENT_HOOK_TOKEN: 'test-token',
            ORCA_PANE_KEY: 'test-pane'
          }
        : {}
      const result = await runPosixHook(script, extraEnv)
      expect(result.exitCode, `${agent} exit code`).toBe(0)
      expect(result.stdinErrors, `${agent} stdin errors`).toHaveLength(0)
    }
  })

  it('does not need PATH to capture or drain POSIX hook stdin', async () => {
    const scripts = await generatePosixScripts()
    for (const [agent, script] of scripts) {
      const result = await runPosixHook(script, { PATH: '' })
      expect(result.exitCode, `${agent} exit code`).toBe(0)
      expect(result.stdinErrors, `${agent} stdin errors`).toHaveLength(0)
    }

    const missing = await runPosixHook(wrapPosixHookCommand('/missing/orca-hook.sh'), { PATH: '' })
    expect(missing.exitCode, 'missing script launcher exit code').toBe(0)
    expect(missing.stdinErrors, 'missing script launcher stdin errors').toHaveLength(0)
  })

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

  it('drains before Claude skips hooks imported by Devin', async () => {
    const script = (await generatePosixScripts('claude')).get('claude claude-hook.sh')
    expect(script).toBeDefined()
    const result = await runPosixHook(script!, { DEVIN_PROJECT_DIR: '/tmp/devin-project' })
    expect(result.exitCode).toBe(0)
    expect(result.stdinErrors).toHaveLength(0)
  })

  it('drains before Codex skips hooks under a Claude background job', async () => {
    const script = (await generatePosixScripts('codex')).get('codex codex-hook.sh')
    expect(script).toBeDefined()
    const result = await runPosixHook(script!, { CLAUDE_JOB_DIR: '/tmp/claude-job' })
    expect(result.exitCode).toBe(0)
    expect(result.stdinErrors).toHaveLength(0)
  })

  it('drains a large payload when the configured script is missing', async () => {
    const result = await runPosixHook(wrapPosixHookCommand('/missing/orca-hook.sh'))
    expect(result.exitCode).toBe(0)
    expect(result.stdinErrors).toHaveLength(0)
  })
})
