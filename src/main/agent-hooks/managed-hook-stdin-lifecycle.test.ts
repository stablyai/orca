// Why: stdin ownership is a cross-agent process contract; one executable
// matrix catches an unread early exit without duplicating template assertions.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SFTPWrapper } from 'ssh2'
import type * as osModule from 'node:os'

let isolatedUserDataDir = ''
let previousUserDataPath: string | undefined

beforeEach(() => {
  previousUserDataPath = process.env.ORCA_USER_DATA_PATH
  isolatedUserDataDir = mkdtempSync(join(tmpdir(), 'orca-hook-stdin-user-data-'))
  // Why: Orca-managed Codex hooks resolve through ORCA_USER_DATA_PATH before
  // the mocked home; an inherited live path would let this test rewrite them.
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

function findGitBash(): string {
  if (process.env.KIMI_SHELL_PATH) {
    return process.env.KIMI_SHELL_PATH
  }
  const candidates = [
    process.env.ProgramFiles && join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe'),
    process.env['ProgramFiles(x86)'] &&
      join(process.env['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe'),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe')
  ]
  const bash = candidates.find((candidate): candidate is string =>
    Boolean(candidate && existsSync(candidate))
  )
  if (!bash) {
    throw new Error('Git Bash is required for the Windows Kimi hook lifecycle test')
  }
  return bash
}

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

import { AntigravityHookService } from '../antigravity/hook-service'
import { ClaudeHookService } from '../claude/hook-service'
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
import {
  wrapPosixHookCommand,
  wrapWindowsGitBashHookCommand,
  wrapWindowsHookCommand
} from './installer-utils'
import { createAgentHookMemorySftp } from './agent-hook-memory-sftp.test-fixture'

const REMOTE_HOME = '/home/dev'
const LARGE_PAYLOAD = Buffer.alloc(1_000_000, 'x')
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
}

function runHookProcess(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<HookRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env, stdio: ['pipe', 'ignore', 'ignore'] })
    const stdinErrors: NodeJS.ErrnoException[] = []
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('hook did not finish after stdin closed'))
    }, 10_000)
    child.on('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.stdin.on('error', (error: NodeJS.ErrnoException) => stdinErrors.push(error))
    child.on('close', (exitCode) => {
      clearTimeout(timeout)
      resolve({ exitCode, stdinErrors })
    })
    child.stdin.end(LARGE_PAYLOAD)
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

async function generatePosixScripts(): Promise<Map<string, string>> {
  const scripts = new Map<string, string>()
  for (const entry of REMOTE_INSTALLERS) {
    const memory = createAgentHookMemorySftp()
    const status = await entry.install(memory.sftp)
    expect(status.state, `${entry.agent} install status`).toBe('installed')
    const generated = [...memory.fs.files.entries()].filter(
      ([path]) => path.includes('/.orca/agent-hooks/') && path.endsWith('.sh')
    )
    // Why: Claude ships a second managed script (the statusline usage feed); the stdin lifecycle contract applies to every generated script.
    expect(generated.length, `${entry.agent} generated scripts`).toBeGreaterThan(0)
    for (const [path, script] of generated) {
      scripts.set(`${entry.agent} ${path.split('/').pop()}`, script)
    }
  }
  return scripts
}

function withPlatform<T>(platform: NodeJS.Platform, run: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  try {
    return run()
  } finally {
    if (original) {
      Object.defineProperty(process, 'platform', original)
    }
  }
}

describe('Windows managed hook stdin structure', () => {
  it('routes every batch guard to a shared drain epilogue', () => {
    const home = mkdtempSync(join(tmpdir(), 'orca-hook-stdin-windows-'))
    homedirMock.mockReturnValue(home)
    const previousGrokHome = process.env.GROK_HOME
    const previousKimiHome = process.env.KIMI_CODE_HOME
    delete process.env.GROK_HOME
    delete process.env.KIMI_CODE_HOME
    try {
      withPlatform('win32', () => {
        for (const entry of LOCAL_INSTALLERS) {
          expect(entry.install().state, `${entry.agent} install status`).toBe('installed')
        }
      })
      const hooksDir = join(home, '.orca', 'agent-hooks')
      const fileNames = readdirSync(hooksDir)
      const mainBatchScripts = fileNames.filter(
        (name) => name.endsWith('-hook.cmd') && !name.startsWith('antigravity-')
      )
      mainBatchScripts.push('antigravity-hook.cmd')
      expect(mainBatchScripts).toHaveLength(10)
      for (const fileName of mainBatchScripts) {
        const script = readFileSync(join(hooksDir, fileName), 'utf8')
        expect(script, `${fileName} port guard`).toContain(
          'if "%ORCA_AGENT_HOOK_PORT%"=="" goto :orca_agent_hook_drain_stdin'
        )
        expect(script, `${fileName} token guard`).toContain(
          'if "%ORCA_AGENT_HOOK_TOKEN%"=="" goto :orca_agent_hook_drain_stdin'
        )
        expect(script, `${fileName} pane guard`).toContain(
          'if "%ORCA_PANE_KEY%"=="" goto :orca_agent_hook_drain_stdin'
        )
        expect(script, `${fileName} drain epilogue`).toContain(
          [
            ':orca_agent_hook_drain_stdin',
            '"%SystemRoot%\\System32\\more.com" >nul 2>nul',
            'exit /b 0'
          ].join('\r\n')
        )
      }

      const copilot = readFileSync(join(hooksDir, 'copilot-hook.ps1'), 'utf8')
      expect(copilot.indexOf('[Console]::In.ReadToEnd()')).toBeLessThan(
        copilot.indexOf('if (-not $env:ORCA_AGENT_HOOK_PORT')
      )
      const kimi = readFileSync(join(hooksDir, 'kimi-hook.sh'), 'utf8')
      expect(kimi.indexOf('payload=$(cat)')).toBeLessThan(kimi.indexOf('exit 0'))
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
    'executes every local script and missing-script launcher without a broken writer',
    async () => {
      const home = mkdtempSync(join(tmpdir(), 'orca-hook-stdin-windows-live-'))
      homedirMock.mockReturnValue(home)
      try {
        const gitBash = findGitBash()
        for (const entry of LOCAL_INSTALLERS) {
          expect(entry.install().state, `${entry.agent} install status`).toBe('installed')
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
          expect(result.stdinErrors, `${fileName} stdin errors`).toHaveLength(0)
        }

        const missingScript = 'C:\\missing\\orca-hook.cmd'
        // Why: the cmd fast path is intentionally a bare, directly-spawnable .cmd
        // path (Codex/Antigravity/Devin launch it as argv[0], not via cmd.exe), so
        // it cannot own stdin for a missing script — a cmd-builtin drain would make
        // argv[0] unspawnable and fail every hook (#8430 regression). Only launchers
        // that already require a real interpreter (encoded PowerShell, Git Bash)
        // drain a missing script; the bare path's missing-script behavior is a
        // normal launch failure, covered in installer-utils.test.ts.
        const launcherCases = [
          {
            name: 'encoded PowerShell',
            executable: 'cmd.exe',
            args: ['/d', '/c', wrapWindowsHookCommand(missingScript)]
          },
          {
            name: 'Git Bash fast path',
            executable: gitBash,
            args: ['-lc', wrapWindowsGitBashHookCommand(missingScript)]
          }
        ]
        for (const launcher of launcherCases) {
          const result = await runHookProcess(launcher.executable, launcher.args, hookEnvironment())
          expect(result.exitCode, `${launcher.name} exit code`).toBe(0)
          expect(result.stdinErrors, `${launcher.name} stdin errors`).toHaveLength(0)
        }
      } finally {
        homedirMock.mockImplementation(() => process.env.HOME ?? tmpdir())
        rmSync(home, { recursive: true, force: true })
      }
    }
  )
})

describe.skipIf(process.platform === 'win32')('managed hook stdin lifecycle', () => {
  it('captures stdin before every possible whole-script success exit', async () => {
    const scripts = await generatePosixScripts()
    for (const [agent, script] of scripts) {
      const captureIndex = script.indexOf('payload=$(cat)')
      const firstExitIndex = script.indexOf('exit 0')
      expect(captureIndex, `${agent} payload capture`).toBeGreaterThanOrEqual(0)
      expect(firstExitIndex, `${agent} first success exit`).toBeGreaterThan(captureIndex)
    }
  })

  it('accepts a large payload without Orca environment or a broken writer', async () => {
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

  it('drains before Claude skips hooks imported by Devin', async () => {
    const script = (await generatePosixScripts()).get('claude claude-hook.sh')
    expect(script).toBeDefined()
    const result = await runPosixHook(script!, { DEVIN_PROJECT_DIR: '/tmp/devin-project' })
    expect(result.exitCode).toBe(0)
    expect(result.stdinErrors).toHaveLength(0)
  })

  it('drains a large payload when the configured script is missing', async () => {
    const result = await runPosixHook(wrapPosixHookCommand('/missing/orca-hook.sh'))
    expect(result.exitCode).toBe(0)
    expect(result.stdinErrors).toHaveLength(0)
  })
})
