import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const { homedirMock } = vi.hoisted(() => ({
  homedirMock: vi.fn<() => string>()
}))

vi.mock('os', async () => {
  const actual = (await vi.importActual('os')) as Record<string, unknown>
  return {
    ...actual,
    homedir: homedirMock
  }
})

import { getGrokToolEventMatcherForTests, GrokHookService } from './hook-service'
import { buildWindowsGrokHookScript } from './windows-grok-hook-script'
import { POSIX_HOOK_STDIN_READER } from '../agent-hooks/hook-stdin-contract'

const GROK_SCRIPT_FILE_NAME = process.platform === 'win32' ? 'grok-hook.cmd' : 'grok-hook.sh'
const WINDOWS_POWERSHELL_LAUNCHER =
  /^[A-Za-z]:\/[^"]*\/System32\/WindowsPowerShell\/v1\.0\/powershell\.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand \S+$/

// Why (#14828): Windows registers the bare script path when it is cmd-safe and only falls back
// to the encoded launcher for a profile path that is not (#6078). windows-hook-launcher-chain
// .test.ts pins which branch applies; these cases only care that Orca's hook is present.
function registersManagedGrokScript(command: string): boolean {
  return command.includes(GROK_SCRIPT_FILE_NAME) || WINDOWS_POWERSHELL_LAUNCHER.test(command)
}

type WindowsGrokHookRun = {
  status: number | null
  stderr: string
  stdout: string
  request?: { path: string; body: string }
}

function createWindowsGrokHookEnvironment(grokHome?: string): NodeJS.ProcessEnv {
  const env = { ...process.env } as NodeJS.ProcessEnv
  delete env.ORCA_AGENT_HOOK_ENDPOINT
  if (grokHome === undefined) {
    delete env.GROK_HOME
  } else {
    env.GROK_HOME = grokHome
  }
  env.ORCA_AGENT_HOOK_TOKEN = 'test-token'
  env.ORCA_PANE_KEY = 'pane-test'
  return env
}

async function runWindowsGrokHook(
  scriptPath: string,
  env: NodeJS.ProcessEnv,
  input: string
): Promise<WindowsGrokHookRun> {
  let request: WindowsGrokHookRun['request']
  const server = createServer((incoming, response) => {
    let body = ''
    incoming.setEncoding('utf8')
    incoming.on('data', (chunk: string) => {
      body += chunk
    })
    incoming.on('end', () => {
      request = { path: incoming.url ?? '', body }
      response.writeHead(204).end()
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Could not resolve Windows Grok hook test listener port')
  }
  env.ORCA_AGENT_HOOK_PORT = String(address.port)
  try {
    const result = await new Promise<Omit<WindowsGrokHookRun, 'request'>>((resolve, reject) => {
      const child = spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', scriptPath], {
        env,
        stdio: ['pipe', 'pipe', 'pipe']
      })
      let stderr = ''
      let stdout = ''
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        stderr += chunk
      })
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        stdout += chunk
      })
      child.once('error', reject)
      child.once('close', (status) => resolve({ status, stderr, stdout }))
      child.stdin.end(input)
    })
    return { ...result, request }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

describe('GrokHookService', () => {
  let homeDir: string

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'orca-grok-home-'))
    homedirMock.mockReturnValue(homeDir)
  })

  afterEach(() => {
    vi.clearAllMocks()
    rmSync(homeDir, { recursive: true, force: true })
  })

  // Why: #9358 / #9941 — empty GROK_HOME + parse-time %VAR:~n,m% / `"\"` broke
  // every SessionStart/UserPromptSubmit on Windows outside Orca terminals.
  it('guards Windows GROK_HOME substring checks when empty (#9358)', () => {
    const script = buildWindowsGrokHookScript()
    expect(script).toContain('set "ORCA_GROK_HOME="')
    expect(script).toContain('if not defined GROK_HOME goto :orca_grok_home_ready')
    expect(script).toContain('%GROK_HOME:~4096,1%')
    expect(script).toContain('set "ORCA_GROK_HOME=%GROK_HOME:"=%"')
    expect(script).toContain('%ORCA_GROK_HOME:~4096,1%')
    expect(script).toContain(':orca_grok_home_ready')
    expect(script).toContain('if not defined ORCA_GROK_HOME goto :orca_grok_home_ready')
    expect(script).toContain('if "%ORCA_GROK_HOME:~-1%"=="\\"')
    expect(script).toContain('if not "%GROK_HOME:~4096,1%"=="" goto :orca_grok_home_ready')
    // Why: parenthesized `if defined (...)` still parse-expands the body early.
    expect(script).not.toMatch(/if defined GROK_HOME \(/)
  })

  it.skipIf(process.platform !== 'win32')(
    'generated grok-hook.cmd exits 0 when GROK_HOME is unset (#9358)',
    async () => {
      const scriptPath = join(homeDir, 'grok-hook-unset.cmd')
      writeFileSync(scriptPath, buildWindowsGrokHookScript(), 'utf8')
      // Why: delete GROK_HOME rather than set '' so cmd sees "not defined".
      const result = await runWindowsGrokHook(
        scriptPath,
        createWindowsGrokHookEnvironment(),
        '{"hook_event_name":"SessionStart"}'
      )
      expect(result.status, `stderr=${result.stderr}\nstdout=${result.stdout}`).toBe(0)
      expect(`${result.stderr ?? ''}${result.stdout ?? ''}`).not.toMatch(
        /syntax of the command is incorrect|命令语法不正确/i
      )
      expect(result.request?.path).toBe('/hook/grok')
      const form = new URLSearchParams(result.request?.body)
      expect(form.get('grokHome')).toBe('')
      expect(form.get('payload')).toBe('{"hook_event_name":"SessionStart"}')
    }
  )

  it.skipIf(process.platform !== 'win32')(
    'generated grok-hook.cmd exits 0 with trailing-backslash GROK_HOME (#9358)',
    async () => {
      const scriptPath = join(homeDir, 'grok-hook-slash.cmd')
      writeFileSync(scriptPath, buildWindowsGrokHookScript(), 'utf8')
      const trailing = `${join(homeDir, 'grok-home-with-slash')}\\`
      const result = await runWindowsGrokHook(
        scriptPath,
        createWindowsGrokHookEnvironment(trailing),
        '{"hook_event_name":"UserPromptSubmit"}'
      )
      expect(result.status, `stderr=${result.stderr}\nstdout=${result.stdout}`).toBe(0)
      expect(`${result.stderr ?? ''}${result.stdout ?? ''}`).not.toMatch(
        /syntax of the command is incorrect|命令语法不正确/i
      )
      expect(result.request?.path).toBe('/hook/grok')
      const form = new URLSearchParams(result.request?.body)
      expect(form.get('grokHome')).toBe(`${trailing}.`)
      expect(form.get('payload')).toBe('{"hook_event_name":"UserPromptSubmit"}')
    }
  )

  it.skipIf(process.platform !== 'win32')(
    'generated grok-hook.cmd exits 0 with an oversized GROK_HOME (#9358)',
    async () => {
      const scriptPath = join(homeDir, 'grok-hook-oversized.cmd')
      writeFileSync(scriptPath, buildWindowsGrokHookScript(), 'utf8')
      const result = await runWindowsGrokHook(
        scriptPath,
        createWindowsGrokHookEnvironment(`C:\\${'a'.repeat(9000)}`),
        '{"hook_event_name":"UserPromptSubmit"}'
      )
      expect(result.status, `stderr=${result.stderr}\nstdout=${result.stdout}`).toBe(0)
      expect(`${result.stderr ?? ''}${result.stdout ?? ''}`).not.toMatch(
        /syntax of the command is incorrect|命令语法不正确/i
      )
      expect(result.request?.path).toBe('/hook/grok')
      const form = new URLSearchParams(result.request?.body)
      expect(form.get('grokHome')).toBe('')
      expect(form.get('payload')).toBe('{"hook_event_name":"UserPromptSubmit"}')
    }
  )

  it.skipIf(process.platform !== 'win32')(
    'omits a max-length trailing-backslash GROK_HOME after safe normalization (#9358)',
    async () => {
      const scriptPath = join(homeDir, 'grok-hook-max-trailing.cmd')
      writeFileSync(scriptPath, buildWindowsGrokHookScript(), 'utf8')
      const trailingAtLimit = `C:\\${'a'.repeat(4092)}\\`
      expect(trailingAtLimit).toHaveLength(4096)
      const result = await runWindowsGrokHook(
        scriptPath,
        createWindowsGrokHookEnvironment(trailingAtLimit),
        '{"hook_event_name":"UserPromptSubmit"}'
      )
      expect(result.status, `stderr=${result.stderr}\nstdout=${result.stdout}`).toBe(0)
      expect(result.request?.path).toBe('/hook/grok')
      const form = new URLSearchParams(result.request?.body)
      expect(form.get('grokHome')).toBe('')
      expect(form.get('payload')).toBe('{"hook_event_name":"UserPromptSubmit"}')
    }
  )

  it('installs a dedicated global Grok hook config and managed script', () => {
    const status = new GrokHookService().install()

    expect(status.state).toBe('installed')
    expect(status.configPath).toBe(join(homeDir, '.grok', 'hooks', 'orca-status.json'))
    expect(status.managedHooksPresent).toBe(true)

    const config = JSON.parse(
      readFileSync(join(homeDir, '.grok', 'hooks', 'orca-status.json'), 'utf8')
    ) as {
      hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]>
    }
    expect(Object.keys(config.hooks).sort()).toEqual(
      [
        'Notification',
        'PostToolUse',
        'PostToolUseFailure',
        'PreToolUse',
        'SessionEnd',
        'SessionStart',
        'Stop',
        'StopFailure',
        'UserPromptSubmit'
      ].sort()
    )
    // Why: Grok matchers are real regexes; bare `*` does not match-all.
    expect(config.hooks.PreToolUse[0].matcher).toBe('.*')
    expect(config.hooks.PostToolUseFailure[0].matcher).toBe('.*')
    expect(config.hooks.PostToolUse[0].matcher).toBe('.*')
    // Why: StopFailure must not carry a tool matcher — lifecycle-only event.
    expect(config.hooks.StopFailure[0].matcher).toBeUndefined()
    expect(config.hooks.Notification[0].matcher).toBeUndefined()
    // Why: assert the shipped helper still matches what install wrote (regression
    // guard if GROK_TOOL_EVENT_MATCHER drifts from install).
    expect(getGrokToolEventMatcherForTests()).toBe('.*')
    expect(getGrokToolEventMatcherForTests()).not.toBe('*')
    expect(new RegExp(getGrokToolEventMatcherForTests()).test('run_terminal_command')).toBe(true)
    // Why: build the invalid pattern at runtime so static lint does not flag it.
    const bareStar = ['*', ''].join('')
    expect(() => new RegExp(bareStar)).toThrow()
    expect(registersManagedGrokScript(config.hooks.PreToolUse[0].hooks[0].command)).toBe(true)
    if (process.platform !== 'win32') {
      expect(config.hooks.PreToolUse[0].hooks[0].command).toContain(join(homeDir, '.orca'))
    }

    const script = readFileSync(
      join(homeDir, '.orca', 'agent-hooks', GROK_SCRIPT_FILE_NAME),
      'utf8'
    )
    expect(script).toContain('/hook/grok')
    if (process.platform === 'win32') {
      expect(script).toContain('%SystemRoot%\\System32\\curl.exe')
      // Why: windows-grok-hook-script.test.ts pins the GROK_HOME guard shape itself,
      // and does so on every platform rather than only on Windows runners.
      expect(script).toContain('set "ORCA_GROK_HOME=%GROK_HOME:"=%"')
      expect(script).toContain('--data-urlencode "grokHome=%ORCA_GROK_HOME%"')
    } else {
      // Why: payload is piped to curl via stdin (`payload@-`) so it never lands
      // on the curl command line (EDR oversized-command-line false positive).
      expect(script).toContain(`payload=$(${POSIX_HOOK_STDIN_READER})`)
      expect(script).toContain('printf \'%s\' "$payload" | curl')
      expect(script).toContain('--data-urlencode "payload@-"')
      expect(script).toContain('${#GROK_HOME}" -le 4096')
      expect(script).toContain('--data-urlencode "grokHome=${grok_home}"')
      expect(script).not.toContain('--data-urlencode "payload=${payload}"')
    }
  })

  // Why: #6078 — a Windows user profile path with a space used to be written
  // verbatim as the hook command, so the agent split it at the space. The
  // managed command must use an encoded launcher so the path never appears raw
  // on the cmd.exe command line.
  it.skipIf(process.platform !== 'win32')(
    'wraps the managed hook command to survive spaces in the profile path (#6078)',
    () => {
      const spaceHome = join(tmpdir(), 'orca grok home with spaces')
      mkdirSync(spaceHome, { recursive: true })
      homedirMock.mockReturnValue(spaceHome)
      try {
        expect(new GrokHookService().install().state).toBe('installed')

        const config = JSON.parse(
          readFileSync(join(spaceHome, '.grok', 'hooks', 'orca-status.json'), 'utf8')
        ) as { hooks: Record<string, { hooks: { command: string }[] }[]> }

        for (const eventName of ['SessionStart', 'UserPromptSubmit', 'Stop']) {
          const command = config.hooks[eventName]?.[0]?.hooks?.[0]?.command
          expect(command).toMatch(WINDOWS_POWERSHELL_LAUNCHER)
        }
      } finally {
        rmSync(spaceHome, { recursive: true, force: true })
      }
    }
  )

  it('installs hooks under GROK_HOME when set', () => {
    const grokHome = mkdtempSync(join(tmpdir(), 'orca-grok-home-env-'))
    const previous = process.env.GROK_HOME
    process.env.GROK_HOME = grokHome
    try {
      const status = new GrokHookService().install()
      expect(status.state).toBe('installed')
      expect(status.configPath).toBe(join(grokHome, 'hooks', 'orca-status.json'))
      expect(readFileSync(join(grokHome, 'hooks', 'orca-status.json'), 'utf8')).toContain(
        'SessionStart'
      )
      // Why: must not also write into the mocked ~/.grok when GROK_HOME wins.
      expect(() =>
        readFileSync(join(homeDir, '.grok', 'hooks', 'orca-status.json'), 'utf8')
      ).toThrow()
    } finally {
      if (previous === undefined) {
        delete process.env.GROK_HOME
      } else {
        process.env.GROK_HOME = previous
      }
      rmSync(grokHome, { recursive: true, force: true })
    }
  })

  it('preserves user-authored hook entries in the Orca Grok config file', () => {
    const configPath = join(homeDir, '.grok', 'hooks', 'orca-status.json')
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          hooks: {
            Notification: [
              {
                hooks: [{ type: 'command', command: '/usr/local/bin/user-hook' }]
              }
            ]
          }
        },
        null,
        2
      )}\n`
    )

    new GrokHookService().install()

    const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>
    }
    const commands = config.hooks.Notification.flatMap((definition) =>
      definition.hooks.map((hook) => hook.command)
    )
    expect(commands).toContain('/usr/local/bin/user-hook')
    expect(commands.some(registersManagedGrokScript)).toBe(true)
  })
})
