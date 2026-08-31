// Why: stdin ownership is a cross-agent process contract; one executable
// matrix catches an unread early exit without duplicating template assertions.
// Exception (#11549): Windows batch hooks give up stdin ownership on the
// missing-Orca-env path, so their writer may break there.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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
import { POSIX_HOOK_STDIN_READER } from './hook-stdin-contract'
import { wrapRuntimeHomeHookCommand } from './runtime-home-hook-command'
import { createAgentHookMemorySftp } from './agent-hook-memory-sftp.test-fixture'
import { findGitBash } from './windows-git-bash-path.test-fixture'

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
  stderr: string
  stdout: string
}

function runHookProcess(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<HookRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env, stdio: ['pipe', 'pipe', 'pipe'] })
    const stdinErrors: NodeJS.ErrnoException[] = []
    let stderr = ''
    let stdout = ''
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('hook did not finish after stdin closed'))
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

// Why: the Codex installer awaits an app-server trust-grant session, so the
// override has to stay pinned across the await instead of being restored by a
// synchronous `finally` while the install is still running.
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
  it('exits immediately when Orca env is missing and keeps drain for other failures', async () => {
    const home = mkdtempSync(join(tmpdir(), 'orca-hook-stdin-windows-'))
    homedirMock.mockReturnValue(home)
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
      expect(mainBatchScripts).toHaveLength(10)
      for (const fileName of mainBatchScripts) {
        const script = readFileSync(join(hooksDir, fileName), 'utf8')
        // Why: missing-env path must not touch more.com — hang class from #11549.
        expect(script, `${fileName} port guard`).toContain(
          'if "%ORCA_AGENT_HOOK_PORT%"=="" exit /b 0'
        )
        expect(script, `${fileName} token guard`).toContain(
          'if "%ORCA_AGENT_HOOK_TOKEN%"=="" exit /b 0'
        )
        expect(script, `${fileName} pane guard`).toContain('if "%ORCA_PANE_KEY%"=="" exit /b 0')
        // Why: pin the rule, not today's three guards — a fourth ORCA_* guard routed to the
        // drain would reintroduce #11549 with this suite green. The pattern spans the guard so
        // it catches both `if "%VAR%"==""` and `if not defined VAR`; the Devin skip names no
        // ORCA_* var, so it stays exempt.
        expect(script, `${fileName} no ORCA_* guard may route to the more.com drain`).not.toMatch(
          /ORCA_[A-Z_]+.*goto :?orca_agent_hook_drain_stdin/
        )
        // Why: the epilogue stays shared — claude-hook.cmd still jumps to it from the
        // Devin-imports-.claude skip, which now sits below these guards.
        expect(script, `${fileName} drain epilogue`).toContain(
          [
            ':orca_agent_hook_drain_stdin',
            '"%SystemRoot%\\System32\\more.com" >nul 2>nul',
            'exit /b 0'
          ].join('\r\n')
        )
      }

      // Why (#11549): the Devin skip is the only remaining in-script jump to more.com, so it
      // must sit below the env guards — otherwise a Devin session outside an Orca pane still
      // parks there and strands the hook exactly like the pre-fix guards did.
      const claude = readFileSync(join(hooksDir, 'claude-hook.cmd'), 'utf8')
      expect(claude, 'claude devin guard present').toContain(
        'if not "%DEVIN_PROJECT_DIR%"=="" goto :orca_agent_hook_drain_stdin'
      )
      expect(claude.indexOf('if "%ORCA_PANE_KEY%"=="" exit /b 0')).toBeLessThan(
        claude.indexOf('if not "%DEVIN_PROJECT_DIR%"=="" goto :orca_agent_hook_drain_stdin')
      )

      // Why (#11549 class): every Windows-local hook now guards before owning stdin —
      // the caller may abandon the pipe, and the payload is discarded on this path anyway.
      const copilot = readFileSync(join(hooksDir, 'copilot-hook.ps1'), 'utf8')
      expect(copilot.indexOf('if (-not $env:ORCA_AGENT_HOOK_PORT')).toBeGreaterThan(-1)
      expect(copilot.indexOf('if (-not $env:ORCA_AGENT_HOOK_PORT')).toBeLessThan(
        copilot.indexOf('[Console]::In.ReadToEnd()')
      )
      const kimi = readFileSync(join(hooksDir, 'kimi-hook.sh'), 'utf8')
      expect(kimi.indexOf('if [ -z "$ORCA_AGENT_HOOK_PORT" ]')).toBeGreaterThan(-1)
      expect(kimi.indexOf('if [ -z "$ORCA_AGENT_HOOK_PORT" ]')).toBeLessThan(
        kimi.indexOf(`payload=$(${POSIX_HOOK_STDIN_READER})`)
      )
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
          // Why (#11549 class): every Windows-local hook exits before owning stdin when the
          // Orca env is missing, so the writer may break — EPIPE, or ECONNRESET when Windows
          // tears the pipe down first. hookEnvironment() strips every ORCA_* var, so this
          // relaxation only ever covers the missing-env path — a happy-path case added to
          // this loop must not reuse it.
          for (const error of result.stdinErrors) {
            expect(['EPIPE', 'ECONNRESET'], `${fileName} stdin error`).toContain(error.code)
          }
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
            name: 'portable Git Bash launcher',
            executable: gitBash,
            args: ['-lc', wrapRuntimeHomeHookCommand('missing-orca-hook')]
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

  // Why: command-shape tests missed conhost discarding the JSON consumers observe (#14818).
  it.skipIf(process.platform !== 'win32')(
    'emits parseable JSON on stdout from the registered Claude hook command, through cmd.exe and Git Bash',
    async () => {
      const home = mkdtempSync(join(tmpdir(), 'orca-hook-stdout-json-'))
      homedirMock.mockReturnValue(home)
      try {
        expect(new ClaudeHookService().install().state).toBe('installed')
        const settings = JSON.parse(
          readFileSync(join(home, '.claude', 'settings.json'), 'utf8')
        ) as { hooks: Record<string, { hooks: { command: string; args?: string[] }[] }[]> }
        const entry = settings.hooks.PreToolUse[0].hooks[0]
        expect(entry.args).toBeUndefined()

        // Why: MSYS rewrites switches and paths, so the command must survive both shells (#14815).
        const gitBash = findGitBash()
        const shells = [
          { name: 'cmd.exe', executable: 'cmd.exe', args: ['/d', '/c', entry.command] },
          { name: 'Git Bash', executable: gitBash, args: ['-c', entry.command] }
        ]
        // Why: cover guard exit, reached curl, and the launcher's missing-script fallback.
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
            name: 'missing managed script',
            env: hookEnvironment({ USERPROFILE: join(home, 'absent') })
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
        }
      } finally {
        homedirMock.mockImplementation(() => process.env.HOME ?? tmpdir())
        rmSync(home, { recursive: true, force: true })
      }
    },
    // Why: six shell launches can overrun the default while the suite competes for cores.
    60_000
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
      const captureIndex = script.indexOf(`payload=$(${POSIX_HOOK_STDIN_READER})`)
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

  // Why: an unread stdin still exits 0, so exit codes alone cannot prove the
  // reader consumed the payload. Assert the captured byte count directly.
  it.each([
    ['empty PATH', ''],
    // Why: /bin/cat is absent on NixOS-style hosts, so an absolute path alone is
    // not enough; the reader must fall back to the shell's default PATH.
    ['PATH without coreutils', '/nonexistent'],
    // Why: a worktree-local `cat` must never receive the hook payload.
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
