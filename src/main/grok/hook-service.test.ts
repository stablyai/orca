import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
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
import { GrokHookService } from './hook-service'
import { buildWindowsGrokHookScript } from './windows-grok-hook-script'

const GROK_SCRIPT_FILE_NAME = process.platform === 'win32' ? 'grok-hook.cmd' : 'grok-hook.sh'
const WINDOWS_POWERSHELL_LAUNCHER =
  /^[A-Za-z]:\/[^"]*\/System32\/WindowsPowerShell\/v1\.0\/powershell\.exe -NoProfile -NonInteractive -EncodedCommand \S+$/

// Bare cmd-safe paths and encoded fallback launchers both identify the managed Windows script.
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

  it.skipIf(process.platform !== 'win32')(
    'generated grok-hook.cmd exits 0 when GROK_HOME is unset (#9358)',
    async () => {
      const scriptPath = join(homeDir, 'grok-hook-unset.cmd')
      writeFileSync(scriptPath, buildWindowsGrokHookScript(), 'utf8')
      // Delete rather than empty so cmd observes the undefined-variable path.
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

  // Profile-path spaces need the encoded fallback so Grok cannot split the managed path.

  it('does not restore a user-cleared global hook config on the next launch', () => {
    const service = new GrokHookService()
    const configPath = join(homeDir, '.grok', 'hooks', 'orca-status.json')
    const userClearedConfig = '{  "hooks" : {}  }\n'

    expect(service.install().state).toBe('installed')
    writeFileSync(configPath, userClearedConfig, 'utf8')

    service.install()

    expect(readFileSync(configPath, 'utf8')).toBe(userClearedConfig)
  })

  it('preserves a user-cleared config during session cleanup', () => {
    const service = new GrokHookService()
    const configPath = join(homeDir, '.grok', 'hooks', 'orca-status.json')
    const userClearedConfig = '{  "hooks" : {}  }\n'

    expect(service.install().state).toBe('installed')
    writeFileSync(configPath, userClearedConfig, 'utf8')

    expect(service.remove().state).toBe('not_installed')
    expect(readFileSync(configPath, 'utf8')).toBe(userClearedConfig)
  })

  it('removes the managed config even when a non-hook key remains', () => {
    const service = new GrokHookService()
    const configPath = join(homeDir, '.grok', 'hooks', 'orca-status.json')

    expect(service.install().state).toBe('installed')
    const withSchema = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
    withSchema.$schema = 'https://grok.example/hooks.schema.json'
    writeFileSync(configPath, `${JSON.stringify(withSchema, null, 2)}\n`, 'utf8')

    expect(service.remove().state).toBe('not_installed')

    expect(existsSync(configPath)).toBe(false)
    expect(service.install().state).toBe('installed')
  })

  // Respect startup opt-out while allowing explicit re-enabling to override it.

  it('restores a user-cleared config when the user turns hooks back on', () => {
    const service = new GrokHookService()
    const configPath = join(homeDir, '.grok', 'hooks', 'orca-status.json')
    const userCleared = '{  "hooks" : {}  }\n'

    expect(service.install().state).toBe('installed')
    writeFileSync(configPath, userCleared, 'utf8')

    expect(service.install({ userInitiated: true }).state).toBe('installed')

    expect(readFileSync(configPath, 'utf8')).not.toBe(userCleared)
    expect(service.getStatus().managedHooksPresent).toBe(true)
  })

  // Strip managed entries through symlinks so user dotfile links stay connected.
  it('writes through a symlinked config instead of destroying the link', async () => {
    const service = new GrokHookService()
    const configPath = join(homeDir, '.grok', 'hooks', 'orca-status.json')
    const realConfig = join(homeDir, 'dotfiles', 'orca-status.json')

    expect(service.install().state).toBe('installed')
    mkdirSync(dirname(realConfig), { recursive: true })
    renameSync(configPath, realConfig)
    symlinkSync(realConfig, configPath)

    await service.removeAsync()

    expect(lstatSync(configPath).isSymbolicLink()).toBe(true)
    expect(existsSync(realConfig)).toBe(true)
    expect(service.getStatus().managedHooksPresent).toBe(false)
  })

  it('respects an empty user-managed symlink as an opt-out', () => {
    const service = new GrokHookService()
    const configPath = join(homeDir, '.grok', 'hooks', 'orca-status.json')
    const realConfig = join(homeDir, 'dotfiles', 'orca-status.json')
    const userCleared = '{"hooks":{}}\n'
    mkdirSync(dirname(configPath), { recursive: true })
    mkdirSync(dirname(realConfig), { recursive: true })
    writeFileSync(realConfig, userCleared)
    symlinkSync(realConfig, configPath)

    expect(service.install().state).toBe('not_installed')
    expect(readFileSync(realConfig, 'utf8')).toBe(userCleared)
    expect(lstatSync(configPath).isSymbolicLink()).toBe(true)
  })

  it('writes through a symlinked config on the sync remove path too', () => {
    const service = new GrokHookService()
    const configPath = join(homeDir, '.grok', 'hooks', 'orca-status.json')
    const realConfig = join(homeDir, 'dotfiles', 'orca-status.json')

    expect(service.install().state).toBe('installed')
    mkdirSync(dirname(realConfig), { recursive: true })
    renameSync(configPath, realConfig)
    symlinkSync(realConfig, configPath)

    expect(service.remove().state).toBe('not_installed')

    expect(lstatSync(configPath).isSymbolicLink()).toBe(true)
    expect(existsSync(realConfig)).toBe(true)
    expect(service.getStatus().managedHooksPresent).toBe(false)
  })

  // Identify Orca's prior emptying separately from a deliberate user opt-out after restart.
  it('reinstalls into a symlinked config on the launch after a quit', async () => {
    const service = new GrokHookService()
    const configPath = join(homeDir, '.grok', 'hooks', 'orca-status.json')
    const realConfig = join(homeDir, 'dotfiles', 'orca-status.json')

    expect(service.install().state).toBe('installed')
    mkdirSync(dirname(realConfig), { recursive: true })
    renameSync(configPath, realConfig)
    symlinkSync(realConfig, configPath)
    await service.removeAsync()
    expect(service.getStatus().managedHooksPresent).toBe(false)

    expect(new GrokHookService().install().state).toBe('installed')

    expect(lstatSync(configPath).isSymbolicLink()).toBe(true)
    expect(existsSync(realConfig)).toBe(true)
    expect(service.getStatus().managedHooksPresent).toBe(true)
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
