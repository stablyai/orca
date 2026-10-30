// Real payload delivery catches conhost losing stdin and code-page corruption missed by shape assertions.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '@orca/process-host'
import { createServer, type Server } from 'node:http'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { removeTreeSync } from '../../shared/windows-transient-lock-removal'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type * as osModule from 'node:os'
import type * as NativeHookExecutableModule from './windows-native-hook-executable'

const { homedirMock, bundledHook } = vi.hoisted(() => {
  const bundledHook: { path: string | null } = { path: null }
  return { homedirMock: vi.fn<() => string>(), bundledHook }
})

// Exercise the built binary without packaged resource lookup.
vi.mock('./windows-native-hook-executable', async (importOriginal) => ({
  ...(await importOriginal<typeof NativeHookExecutableModule>()),
  resolveBundledWindowsNativeHookExecutable: () => bundledHook.path
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
import { CommandCodeHookService } from '../command-code/hook-service'
import { CopilotHookService } from '../copilot/hook-service'
import { DroidHookService } from '../droid/hook-service'
import { DevinHookService } from '../devin/hook-service'
import { DshHookService } from '../dsh/hook-service'
import { GeminiHookService } from '../gemini/hook-service'
import { GrokHookService } from '../grok/hook-service'
import { KimiHookService } from '../kimi/hook-service'
import { KiroHookService } from '../kiro/hook-service'
import { MuseHookService } from '../muse/hook-service'
import { getMuseManagedHooksPath } from '../muse/hook-settings'
import { zcodeHookService } from '../zcode/hook-service'
import { readHooksJson, WINDOWS_CMD_SAFE_PATH, wrapWindowsHookCommand } from './installer-utils'
import { getConfigPath, getWindowsManagedLifecycleHook } from '../claude/hook-settings'
import { findGitBash } from './windows-git-bash-path.test-fixture'
import {
  buildWindowsNativeHookExecutable,
  WINDOWS_NATIVE_HOOK_BUILD_TIMEOUT_MS
} from './windows-native-hook-exe.test-fixture'

const PANE_KEY = 'tab-1:leaf-1'
const HOOK_TOKEN = 'payload-delivery-token'
// Multiple chunks and non-ASCII expose pipe truncation and code-page conversion.
const PAYLOAD = JSON.stringify({
  session_id: 'a3f9c1e0-payload-delivery',
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'echo "café 日本語 😀" & echo %PATH% | more' },
  transcript: 'y'.repeat(4096)
})

type HookPost = {
  payload: string | null
  paneKey: string | null
  token: string | null
  hookEventName: string | null
}

async function startHookListener(): Promise<{
  server: Server
  port: number
  posts: HookPost[]
}> {
  const posts: HookPost[] = []
  const server = createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      const form = new URLSearchParams(body)
      const token = req.headers['x-orca-agent-hook-token']
      posts.push({
        payload: form.get('payload'),
        paneKey: form.get('paneKey'),
        token: typeof token === 'string' ? token : null,
        hookEventName: form.get('hookEventName')
      })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
    })
  })
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(typeof address === 'object' && address ? address.port : 0)
    })
  })
  return { server, port, posts }
}

type Runner = {
  name: string
  program: () => string
  args: (command: string) => string[]
  verbatim?: boolean
}

const SYSTEM32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
const CMD = join(SYSTEM32, 'cmd.exe')
const POWERSHELL = join(SYSTEM32, 'WindowsPowerShell', 'v1.0', 'powershell.exe')

const CMD_PLAIN: Runner = {
  name: 'cmd.exe',
  program: () => 'cmd.exe',
  args: (command) => ['/d', '/c', command]
}
const GIT_BASH: Runner = { name: 'Git Bash', program: findGitBash, args: (c) => ['-c', c] }
// Vendor argv below; runners that prefer pwsh fall back to Windows PowerShell 5.1.
const CMD_NODE_SHELL: Runner = {
  name: 'cmd.exe (Node shell:true)',
  program: () => CMD,
  args: (command) => ['/d', '/s', '/c', `"${command}"`],
  verbatim: true
}
const CMD_FACTORY: Runner = {
  name: 'cmd.exe (Factory)',
  program: () => CMD,
  args: (command) => ['/d', '/s', '/c', command],
  verbatim: true
}
const POWERSHELL_GEMINI: Runner = {
  name: 'Windows PowerShell (Gemini)',
  program: () => POWERSHELL,
  args: (command) => [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `${command}; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`
  ]
}
const POWERSHELL_DSH: Runner = {
  name: 'Windows PowerShell (DSH)',
  program: () => POWERSHELL,
  args: (command) => [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;$OutputEncoding=[System.Text.Encoding]::UTF8;${command}`
  ]
}
const POWERSHELL_PLAIN: Runner = {
  name: 'Windows PowerShell',
  program: () => POWERSHELL,
  args: (command) => ['-NoProfile', '-Command', command]
}
function findPwsh(): string | undefined {
  const candidates = [
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
    join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WindowsApps', 'pwsh.exe')
  ]
  // lstat: the Store install is an app-execution alias that existsSync cannot follow.
  return candidates.find((candidate) => lstatSync(candidate, { throwIfNoEntry: false }))
}
// Copilot's `<pwsh|powershell> -nop -nol -c <command>`; pwsh only where it is installed.
const COPILOT_RUNNERS: Runner[] = [POWERSHELL, findPwsh()].flatMap((program) =>
  program
    ? [
        {
          name: `${basename(program)} (Copilot)`,
          program: () => program,
          args: (c: string) => ['-nop', '-nol', '-c', c]
        }
      ]
    : []
)
// CPython's shell=True: `{ComSpec} /c "{command}"`, without `/d`.
const CMD_PYTHON_SHELL: Runner = {
  name: 'cmd.exe (Python shell=True)',
  program: () => CMD,
  args: (command) => ['/c', `"${command}"`],
  verbatim: true
}

// Orca's TOML basic strings use only escapes that a JSON string decodes identically.
function readTomlEventCommands(path: string, event: string): string[] {
  const block = new RegExp(`^event = "${event}"\\r?\\ncommand = ("(?:[^"\\\\]|\\\\.)*")$`, 'gm')
  return [...readFileSync(path, 'utf8').matchAll(block)].map((match) =>
    String(JSON.parse(match[1]))
  )
}

type Entry = { command?: string; powershell?: string; hooks?: { command?: string }[] }
const commandsOf = (entries: Entry[] | undefined): (string | undefined)[] =>
  (entries ?? []).flatMap((entry) =>
    entry.hooks ? entry.hooks.map((h) => h.command) : (entry.command ?? entry.powershell)
  )

function readEvent(path: string, event: string): (string | undefined)[] {
  return commandsOf(JSON.parse(readFileSync(path, 'utf8')).hooks?.[event])
}

// The pre-forward-slash bare path: Git Bash strips its backslashes and exits 127.
const legacyBackslashEntry = (home: string, script: string): Entry => ({
  hooks: [{ command: join(home, '.orca', 'agent-hooks', script) }]
})

function writeHooks(
  path: string,
  hooks: Record<string, Entry[]>,
  extra: { name?: string; version?: number } = {}
): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ ...extra, hooks }))
}

type Provider = {
  name: string
  script: string
  stdout: string
  install: () => { state: string }
  commands: (home: string) => (string | undefined)[]
  /** Seed legacy encoded registration to verify replacement without duplication. */
  seedStale?: (home: string, stale: string) => void
  runners?: Runner[]
  hookEventName?: string
}

const PROVIDERS: Provider[] = [
  {
    name: 'Claude',
    script: 'claude-hook.cmd',
    stdout: '{}',
    install: () => new ClaudeHookService().install(),
    commands: () => commandsOf(readHooksJson(getConfigPath())?.hooks?.PreToolUse)
  },
  {
    // A spaced home cannot carry the bare exe path, so that profile falls back to the `.cmd` hook.
    name: 'Claude (orca-agent-hook.exe)',
    script: 'orca-agent-hook.exe',
    stdout: '{}',
    install: () => {
      bundledHook.path = buildWindowsNativeHookExecutable()
      return new ClaudeHookService().install()
    },
    commands: () => commandsOf(readHooksJson(getConfigPath())?.hooks?.PreToolUse),
    runners: [CMD_PLAIN, GIT_BASH, POWERSHELL_PLAIN]
  },
  {
    name: 'Muse',
    script: 'muse-hook.cmd',
    stdout: '',
    install: () => new MuseHookService().install(),
    commands: () => commandsOf(readHooksJson(getMuseManagedHooksPath())?.hooks?.PreToolUse)
  },
  {
    name: 'Droid',
    script: 'droid-hook.cmd',
    stdout: '',
    install: () => new DroidHookService().install(),
    commands: (home) => readEvent(join(home, '.factory', 'settings.json'), 'UserPromptSubmit'),
    seedStale: (home, stale) =>
      writeHooks(join(home, '.factory', 'settings.json'), {
        UserPromptSubmit: [{ hooks: [{ command: stale }] }]
      }),
    runners: [CMD_FACTORY]
  },
  {
    name: 'Command Code',
    script: 'command-code-hook.cmd',
    stdout: '',
    install: () => new CommandCodeHookService().install(),
    commands: (home) => readEvent(join(home, '.commandcode', 'settings.json'), 'Stop'),
    seedStale: (home, stale) =>
      writeHooks(join(home, '.commandcode', 'settings.json'), {
        Stop: [{ hooks: [{ command: stale }] }]
      }),
    runners: [CMD_NODE_SHELL]
  },
  {
    name: 'Gemini',
    script: 'gemini-hook.cmd',
    stdout: '{}',
    install: () => new GeminiHookService().install(),
    commands: (home) => readEvent(join(home, '.gemini', 'settings.json'), 'BeforeAgent'),
    seedStale: (home, stale) =>
      writeHooks(join(home, '.gemini', 'settings.json'), {
        BeforeAgent: [{ hooks: [{ command: stale }] }]
      }),
    runners: [POWERSHELL_GEMINI]
  },
  {
    // dsh-hooks.json is Orca-owned and rewritten whole, so there is no stale entry to sweep.
    name: 'DSH',
    script: 'dsh-hook.cmd',
    stdout: '',
    install: () => new DshHookService().install(),
    commands: (home) =>
      readEvent(join(home, '.orca', 'agent-hooks', 'dsh-hooks.json'), 'UserPromptSubmit'),
    runners: [POWERSHELL_DSH]
  },
  {
    // Kiro is closed source; cover both shells it could use.
    name: 'Kiro',
    script: 'kiro-hook.cmd',
    stdout: '',
    install: () => new KiroHookService().install(),
    commands: (home) => readEvent(join(home, '.kiro', 'agents', 'mine.json'), 'userPromptSubmit'),
    seedStale: (home, stale) =>
      writeHooks(
        join(home, '.kiro', 'agents', 'mine.json'),
        { userPromptSubmit: [{ command: stale }] },
        { name: 'mine' }
      ),
    runners: [POWERSHELL_PLAIN, CMD_NODE_SHELL]
  },
  {
    name: 'Kimi',
    script: 'kimi-hook.cmd',
    stdout: '',
    install: () => new KimiHookService().install(),
    commands: (home) =>
      readTomlEventCommands(join(home, '.kimi-code', 'config.toml'), 'UserPromptSubmit'),
    runners: [CMD_PYTHON_SHELL]
  },
  {
    // One event stands in for all: each registration differs only in the event argument.
    name: 'Copilot',
    script: 'copilot-hook.cmd',
    stdout: '{}',
    install: () => new CopilotHookService().install(),
    commands: (home) => readEvent(join(home, '.copilot', 'hooks', 'orca.json'), 'Stop'),
    seedStale: (home, stale) =>
      writeHooks(
        join(home, '.copilot', 'hooks', 'orca.json'),
        { Stop: [{ powershell: stale }] },
        { version: 1 }
      ),
    runners: COPILOT_RUNNERS,
    hookEventName: 'Stop'
  },
  {
    // Grok spawns a one-token command directly, wraps a spaced one in PowerShell, or uses Git Bash.
    name: 'Grok',
    script: 'grok-hook.cmd',
    stdout: '',
    install: () => new GrokHookService().install(),
    commands: (home) => readEvent(join(home, '.grok', 'hooks', 'orca-status.json'), 'Stop'),
    seedStale: (home, stale) =>
      writeHooks(join(home, '.grok', 'hooks', 'orca-status.json'), {
        Stop: [{ hooks: [{ command: stale }] }, legacyBackslashEntry(home, 'grok-hook.cmd')]
      }),
    runners: [CMD_PLAIN, GIT_BASH, POWERSHELL_PLAIN]
  },
  {
    name: 'Devin',
    script: 'devin-hook.cmd',
    stdout: '',
    install: () => new DevinHookService().install(),
    commands: (home) => readEvent(join(home, 'AppData', 'Roaming', 'devin', 'config.json'), 'Stop'),
    seedStale: (home, stale) =>
      writeHooks(join(home, 'AppData', 'Roaming', 'devin', 'config.json'), {
        Stop: [{ hooks: [{ command: stale }] }, legacyBackslashEntry(home, 'devin-hook.cmd')]
      }),
    runners: [CMD_PLAIN, GIT_BASH, POWERSHELL_PLAIN]
  },
  {
    // ZCode nests events one level deeper (`hooks.events`) and runs hooks through its own shell resolver.
    name: 'ZCode',
    script: 'zcode-hook.cmd',
    stdout: '',
    install: () => zcodeHookService.install(),
    commands: (home) =>
      commandsOf(
        JSON.parse(readFileSync(join(home, '.zcode', 'cli', 'config.json'), 'utf8')).hooks?.events
          ?.Stop
      ),
    seedStale: (home, stale) => {
      const path = join(home, '.zcode', 'cli', 'config.json')
      mkdirSync(dirname(path), { recursive: true })
      const Stop = [{ hooks: [{ command: stale }] }, legacyBackslashEntry(home, 'zcode-hook.cmd')]
      writeFileSync(path, JSON.stringify({ hooks: { enabled: true, events: { Stop } } }))
    },
    runners: [CMD_PLAIN, GIT_BASH, POWERSHELL_PLAIN]
  }
]

// A space keeps the bare path off the command line, so that profile takes the encoded launcher.
const CASES = PROVIDERS.flatMap((provider) =>
  ['user', 'user name'].map((homeName) => ({ ...provider, homeName }))
)

// Seed the redirected profile AutoRun target so host aliases cannot add cmd stderr noise.
function seedCmdAutoRunTarget(home: string): void {
  writeFileSync(join(home, '.cmd_aliases.cmd'), '@echo off\r\n', 'utf8')
}

// Inherited Orca endpoints must not redirect test payloads away from this listener.
function hookEnvironment(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const base = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('ORCA_'))
  )
  return { ...base, ORCA_BACKGROUND_LAUNCH: '1', ...extra }
}

describe('Windows managed hook launcher', () => {
  // Keep ConPTY shape coverage on hosts that cannot execute Windows delivery tests.
  it('does not re-host the hook on a pseudoconsole', () => {
    const hook = getWindowsManagedLifecycleHook(
      'C:\\Users\\alice\\.orca\\agent-hooks\\claude-hook.cmd'
    )
    expect(hook.command).not.toMatch(/conhost/i)
    expect(hook.args).toBeUndefined()
  })
})

describe.skipIf(process.platform !== 'win32')('Windows managed hook payload delivery', () => {
  let root = ''
  let server: Server | null = null

  afterEach(() => {
    vi.unstubAllEnvs()
    bundledHook.path = null
    server?.close()
    server = null
    homedirMock.mockImplementation(() => process.env.HOME ?? tmpdir())
    if (root) {
      removeTreeSync(root)
      root = ''
    }
  })

  it.each(CASES)(
    '$name delivers the piped payload through its runners (home "$homeName")',
    async (provider) => {
      root = mkdtempSync(join(tmpdir(), 'orca-hook-payload-'))
      const home = join(root, provider.homeName)
      mkdirSync(home)
      homedirMock.mockReturnValue(home)
      for (const name of ['USERPROFILE', 'HOME']) {
        vi.stubEnv(name, home)
      }
      vi.stubEnv('APPDATA', join(home, 'AppData', 'Roaming'))
      for (const name of [
        'XDG_CONFIG_HOME',
        'KIRO_HOME',
        'DSH_HOME',
        'KIMI_CODE_HOME',
        'COPILOT_HOME',
        'GROK_HOME'
      ]) {
        vi.stubEnv(name, undefined)
      }
      seedCmdAutoRunTarget(home)
      const scriptPath = join(home, '.orca', 'agent-hooks', provider.script)
      provider.seedStale?.(home, wrapWindowsHookCommand(scriptPath))
      expect(provider.install().state).toBe('installed')

      const commands = provider.commands(home)
      expect(commands, 'exactly one managed registration').toHaveLength(1)
      const registeredCommand = commands[0]
      if (!registeredCommand) {
        throw new Error(`Missing managed ${provider.name} command`)
      }
      // Cmd-safe paths must avoid per-event interpreter startup.
      if (WINDOWS_CMD_SAFE_PATH.test(scriptPath)) {
        expect(registeredCommand).not.toMatch(/powershell|-EncodedCommand/i)
        if (provider.script.endsWith('.exe')) {
          expect(registeredCommand).toBe(`${scriptPath.replaceAll('\\', '/')} claude`)
        }
      } else {
        expect(registeredCommand).toMatch(/-EncodedCommand/)
      }

      const listener = await startHookListener()
      server = listener.server
      const env = hookEnvironment({
        USERPROFILE: home,
        HOME: home,
        ORCA_AGENT_HOOK_PORT: String(listener.port),
        ORCA_AGENT_HOOK_TOKEN: HOOK_TOKEN,
        ORCA_PANE_KEY: PANE_KEY
      })
      const run = (runner: Runner, runEnv: NodeJS.ProcessEnv) =>
        runProcess({
          program: runner.program(),
          args: runner.args(registeredCommand),
          windowsVerbatimArguments: runner.verbatim,
          env: runEnv,
          input: PAYLOAD,
          timeoutMs: 15_000
        })

      for (const runner of provider.runners ?? [CMD_PLAIN, GIT_BASH]) {
        const before = listener.posts.length
        const result = await run(runner, env)
        expect(result.timedOut, `${runner.name} timed out`).toBe(false)
        expect(result.code, `${runner.name} exit code; stderr: ${result.stderr}`).toBe(0)

        // Compare exact bytes to catch both discarded stdin and code-page corruption.
        expect(listener.posts.slice(before), `${runner.name} posts`).toEqual([
          {
            payload: PAYLOAD,
            paneKey: PANE_KEY,
            token: HOOK_TOKEN,
            hookEventName: provider.hookEventName ?? null
          }
        ])
        expect(result.stderr, `${runner.name} stderr`).toBe('')
        // Gate consumers require parseable stdout.
        expect(result.stdout.trim(), `${runner.name} stdout`).toBe(provider.stdout)

        const outsideOrca = await run(runner, hookEnvironment({ USERPROFILE: home, HOME: home }))
        expect(outsideOrca.timedOut, `${runner.name} outside Orca timed out`).toBe(false)
        expect(outsideOrca.code, `${runner.name} outside Orca exit code`).toBe(0)
        expect(listener.posts).toHaveLength(before + 1)
      }
      // Allow several shell launches, installation, and a cold executable build.
    },
    WINDOWS_NATIVE_HOOK_BUILD_TIMEOUT_MS
  )

  // The control verifies profile-based AutoRun ran; printing it must not corrupt Copilot gate JSON.
  it('Copilot answers exactly {} when the cmd AutoRun prints', async () => {
    root = mkdtempSync(join(tmpdir(), 'orca-hook-autorun-'))
    const home = join(root, 'user')
    mkdirSync(home)
    homedirMock.mockReturnValue(home)
    for (const name of ['USERPROFILE', 'HOME']) {
      vi.stubEnv(name, home)
    }
    vi.stubEnv('COPILOT_HOME', undefined)
    writeFileSync(join(home, '.cmd_aliases.cmd'), '@echo autorun-noise\r\n', 'utf8')
    expect(new CopilotHookService().install().state).toBe('installed')
    const [command] = readEvent(join(home, '.copilot', 'hooks', 'orca.json'), 'PreToolUse')
    if (!command) {
      throw new Error('Missing managed Copilot PreToolUse command')
    }
    const env = hookEnvironment({ USERPROFILE: home, HOME: home })

    const autoRun = await runProcess({ program: CMD, args: ['/c', 'rem'], env, timeoutMs: 15_000 })
    for (const runner of COPILOT_RUNNERS) {
      const result = await runProcess({
        program: runner.program(),
        args: runner.args(command),
        env,
        input: PAYLOAD,
        timeoutMs: 15_000
      })
      expect(result.code, `${runner.name} exit code`).toBe(0)
      expect(result.stdout, `${runner.name} stdout`).toBe('{}\r\n')
    }
    if (autoRun.stdout.includes('autorun-noise')) {
      const bare = command.replace(/^\S+\/cmd\.exe \/d \/c /, '')
      const control = await runProcess({
        program: POWERSHELL,
        args: ['-nop', '-nol', '-c', bare],
        env,
        input: PAYLOAD,
        timeoutMs: 15_000
      })
      expect(control.stdout, 'without /d the AutoRun prints first').toContain('autorun-noise')
    }
  }, 60_000)
})
