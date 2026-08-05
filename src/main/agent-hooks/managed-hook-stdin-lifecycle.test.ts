// Why: stdin ownership is a cross-agent process contract; one executable
// matrix catches an unread early exit without duplicating template assertions.
// Windows batch guards are the one exception: an Orca-less caller gets an
// immediate exit and may see a broken pipe, because more.com would otherwise
// block forever on a caller that never closes stdin (#11549).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
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
import { POSIX_HOOK_STDIN_READER } from './hook-stdin-contract'
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
  stdout: string
}

function runHookProcess(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<HookRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env, stdio: ['pipe', 'pipe', 'ignore'] })
    const stdinErrors: NodeJS.ErrnoException[] = []
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
    child.stdin.on('error', (error: NodeJS.ErrnoException) => stdinErrors.push(error))
    child.on('close', (exitCode) => {
      clearTimeout(timeout)
      resolve({ exitCode, stdinErrors, stdout })
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

const WINDOWS_DRAIN_LABEL_LINE = ':orca_agent_hook_drain_stdin'
const WINDOWS_DRAIN_COMMAND_LINE = '"%SystemRoot%\\System32\\more.com" >nul 2>nul'
// Why: Node surfaces a closed Windows pipe under several codes; anything else
// (EACCES, ENOENT) would mean the script failed rather than exited early.
const BROKEN_PIPE_CODES = new Set(['EPIPE', 'ECONNRESET', 'ERR_STREAM_DESTROYED', 'EOF'])
// Why: these two capture stdin before any guard, so the #8430 no-EPIPE guarantee
// still holds for them even without Orca environment.
const CAPTURES_BEFORE_GUARDS = new Set(['copilot-hook.ps1', 'kimi-hook.sh'])

function orcaHookEnvironment(port: number): NodeJS.ProcessEnv {
  return {
    ORCA_AGENT_HOOK_PORT: String(port),
    ORCA_AGENT_HOOK_TOKEN: 'test-token',
    ORCA_PANE_KEY: 'tab-1:00000000-0000-4000-8000-000000000000',
    // Why: the Grok template substrings %GROK_HOME%; leave it defined so this
    // case exercises the post path rather than undefined-variable expansion.
    GROK_HOME: 'C:\\orca-test-grok-home'
  }
}

// Why: a live reader is what makes the with-Orca-env assertion meaningful — the
// post command must consume the whole payload, not fail before touching stdin.
async function withLoopbackHookServer<T>(run: (port: number) => Promise<T>): Promise<T> {
  const server = createServer((request, response) => {
    request.resume()
    request.on('end', () => response.end('{}'))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    return await run((server.address() as AddressInfo).port)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
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
  it('exits missing-Orca-env guards and keeps a drain epilogue only where a jump survives', () => {
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
        const lines = readFileSync(join(hooksDir, fileName), 'utf8').split('\r\n')
        // Why: a caller without Orca env is not Orca, so it may never close stdin —
        // more.com would then block forever and leak a cmd.exe/more.com pair (#11549).
        expect(lines, `${fileName} port guard`).toContain(
          'if "%ORCA_AGENT_HOOK_PORT%"=="" exit /b 0'
        )
        expect(lines, `${fileName} token guard`).toContain(
          'if "%ORCA_AGENT_HOOK_TOKEN%"=="" exit /b 0'
        )
        expect(lines, `${fileName} pane guard`).toContain('if "%ORCA_PANE_KEY%"=="" exit /b 0')
        // Why: text presence proved nothing once the guards stopped jumping. Emit the
        // epilogue only where a jump survives, so a dead label cannot pose as coverage.
        const jumpIndex = lines.findIndex((line) =>
          line.endsWith(`goto :${WINDOWS_DRAIN_LABEL_LINE.slice(1)}`)
        )
        const labelIndex = lines.indexOf(WINDOWS_DRAIN_LABEL_LINE)
        expect(labelIndex > -1, `${fileName} drain epilogue reachable`).toBe(jumpIndex > -1)
        if (labelIndex > -1) {
          expect(lines.slice(labelIndex, labelIndex + 3), `${fileName} drain epilogue`).toEqual([
            WINDOWS_DRAIN_LABEL_LINE,
            WINDOWS_DRAIN_COMMAND_LINE,
            'exit /b 0'
          ])
        }
      }

      // Why: Claude's Devin skip is the one surviving jump, and it must sit after the
      // Orca-env guards — only an Orca-invoked hook is guaranteed to close stdin.
      const claude = readFileSync(join(hooksDir, 'claude-hook.cmd'), 'utf8').split('\r\n')
      const claudePaneGuardIndex = claude.indexOf('if "%ORCA_PANE_KEY%"=="" exit /b 0')
      const claudeDevinIndex = claude.findIndex((line) =>
        line.startsWith('if not "%DEVIN_PROJECT_DIR%"==""')
      )
      expect(claudePaneGuardIndex, 'claude pane guard').toBeGreaterThan(-1)
      expect(claudeDevinIndex, 'claude Devin skip after Orca guards').toBeGreaterThan(
        claudePaneGuardIndex
      )
      expect(claude.indexOf(WINDOWS_DRAIN_LABEL_LINE), 'claude drain epilogue').toBeGreaterThan(
        claudeDevinIndex
      )
      // Why: OpenClaude has no Devin skip, so nothing can reach a drain there.
      const openClaude = readFileSync(join(hooksDir, 'openclaude-hook.cmd'), 'utf8')
      expect(openClaude, 'openclaude drain').not.toContain(WINDOWS_DRAIN_LABEL_LINE.slice(1))

      // Why: a partially removed install leaves these wrappers behind with the core
      // script gone, which is exactly the never-EOF path #11549 reported.
      const wrapperFileNames = fileNames.filter(
        (name) => name.startsWith('antigravity-') && name !== 'antigravity-hook.cmd'
      )
      expect(wrapperFileNames, 'antigravity event wrappers').toHaveLength(4)
      for (const fileName of wrapperFileNames) {
        const lines = readFileSync(join(hooksDir, fileName), 'utf8').split('\r\n')
        const guardIndex = lines.indexOf('if "%ORCA_PANE_KEY%"=="" exit /b 0')
        const drainIndex = lines.indexOf(WINDOWS_DRAIN_COMMAND_LINE)
        expect(guardIndex, `${fileName} Orca env guard`).toBeGreaterThan(-1)
        expect(drainIndex, `${fileName} drain after Orca env guard`).toBeGreaterThan(guardIndex)
        // Why: the JSON protocol reply must still precede the guard, or Antigravity stalls.
        expect(lines.indexOf('  echo {}'), `${fileName} protocol reply before guard`).toBeLessThan(
          guardIndex
        )
      }

      const copilot = readFileSync(join(hooksDir, 'copilot-hook.ps1'), 'utf8')
      expect(copilot.indexOf('[Console]::In.ReadToEnd()')).toBeLessThan(
        copilot.indexOf('if (-not $env:ORCA_AGENT_HOOK_PORT')
      )
      const kimi = readFileSync(join(hooksDir, 'kimi-hook.sh'), 'utf8')
      expect(kimi.indexOf(`payload=$(${POSIX_HOOK_STDIN_READER})`)).toBeLessThan(
        kimi.indexOf('exit 0')
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
    'exits without Orca env and never breaks an Orca writer',
    async () => {
      const home = mkdtempSync(join(tmpdir(), 'orca-hook-stdin-windows-live-'))
      homedirMock.mockReturnValue(home)
      try {
        const gitBash = findGitBash()
        for (const entry of LOCAL_INSTALLERS) {
          expect(entry.install().state, `${entry.agent} install status`).toBe('installed')
        }
        const hooksDir = join(home, '.orca', 'agent-hooks')
        const eventWrappers = readdirSync(hooksDir).filter(
          (name) => name.startsWith('antigravity-') && name !== 'antigravity-hook.cmd'
        )
        const mainScripts = readdirSync(hooksDir).filter(
          (name) =>
            name === 'antigravity-hook.cmd' ||
            name.endsWith('-hook.ps1') ||
            name.endsWith('-hook.sh') ||
            (name.endsWith('-hook.cmd') && !name.startsWith('antigravity-'))
        )
        expect(mainScripts).toHaveLength(12)
        expect(eventWrappers).toHaveLength(4)
        const spawnArgsFor = (
          fileName: string
        ): { executable: string; args: string[]; scriptPath: string } => {
          const scriptPath = join(hooksDir, fileName)
          if (fileName.endsWith('.cmd')) {
            return { executable: 'cmd.exe', args: ['/d', '/c', scriptPath], scriptPath }
          }
          if (fileName.endsWith('.ps1')) {
            return {
              executable: join(
                process.env.SystemRoot ?? 'C:\\Windows',
                'System32',
                'WindowsPowerShell',
                'v1.0',
                'powershell.exe'
              ),
              args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
              scriptPath
            }
          }
          return { executable: gitBash, args: [scriptPath], scriptPath }
        }

        // Why: the wrappers are only a hang risk once the core script is gone, which is
        // what a partially removed install leaves behind.
        rmSync(join(hooksDir, 'antigravity-hook.cmd'))
        for (const fileName of [...mainScripts, ...eventWrappers]) {
          if (fileName === 'antigravity-hook.cmd') {
            continue
          }
          const { executable, args } = spawnArgsFor(fileName)
          const result = await runHookProcess(executable, args, hookEnvironment())
          // Why: the run must end on its own — a hung more.com is the #11549 leak, and
          // runHookProcess rejects rather than resolving if it never closes.
          expect(result.exitCode, `${fileName} exit code`).toBe(0)
          if (CAPTURES_BEFORE_GUARDS.has(fileName)) {
            expect(result.stdinErrors, `${fileName} stdin errors`).toHaveLength(0)
          } else {
            // Why: batch guards exit before reading, so a caller that is not Orca gets a
            // broken pipe by design; any other errno would mean the script itself failed.
            const unexpected = result.stdinErrors
              .map((error) => error.code ?? 'unknown')
              .filter((code) => !BROKEN_PIPE_CODES.has(code))
            expect(unexpected, `${fileName} unexpected stdin errors`).toEqual([])
          }
        }

        // Why: the #8430 guarantee still has to hold for hooks Orca invokes — nothing
        // about the missing-env exit may cost an Orca-launched agent its payload write.
        for (const entry of LOCAL_INSTALLERS) {
          expect(entry.install().state, `${entry.agent} reinstall status`).toBe('installed')
        }
        await withLoopbackHookServer(async (port) => {
          const orcaEnv = orcaHookEnvironment(port)
          for (const fileName of mainScripts) {
            const { executable, args } = spawnArgsFor(fileName)
            const result = await runHookProcess(executable, args, hookEnvironment(orcaEnv))
            expect(result.exitCode, `${fileName} Orca-env exit code`).toBe(0)
            expect(result.stdinErrors, `${fileName} Orca-env stdin errors`).toHaveLength(0)
          }
          // Why: the Devin skip is the only guard that still drains; it runs after the
          // Orca-env guards, so reaching it proves the surviving epilogue is live.
          const claude = spawnArgsFor('claude-hook.cmd')
          const devinSkip = await runHookProcess(
            claude.executable,
            claude.args,
            hookEnvironment({ ...orcaEnv, DEVIN_PROJECT_DIR: 'C:\\devin-project' })
          )
          expect(devinSkip.exitCode, 'claude Devin skip exit code').toBe(0)
          expect(devinSkip.stdinErrors, 'claude Devin skip stdin errors').toHaveLength(0)
        })

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
