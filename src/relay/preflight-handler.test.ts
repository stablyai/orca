import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildPosixCommandPathLookupScript } from '../shared/posix-command-path-lookup'

const { execFileAsyncMock, runProcessMock } = vi.hoisted(() => ({
  execFileAsyncMock: vi.fn(),
  runProcessMock: vi.fn()
}))

const {
  isPwshAvailableAsyncMock,
  isWslAvailableAsyncMock,
  listWslDistrosAsyncMock,
  isGitBashAvailableMock
} = vi.hoisted(() => ({
  isPwshAvailableAsyncMock: vi.fn(),
  isWslAvailableAsyncMock: vi.fn(),
  listWslDistrosAsyncMock: vi.fn(),
  isGitBashAvailableMock: vi.fn()
}))

vi.mock('child_process', () => {
  const execFileWithPromisify = Object.assign(vi.fn(), {
    [Symbol.for('nodejs.util.promisify.custom')]: execFileAsyncMock
  })
  return { execFile: execFileWithPromisify }
})

vi.mock('../main/pwsh', () => ({ isPwshAvailableAsync: isPwshAvailableAsyncMock }))
vi.mock('../main/wsl', () => ({
  isWslAvailableAsync: isWslAvailableAsyncMock,
  listWslDistrosAsync: listWslDistrosAsyncMock
}))
vi.mock('../main/git-bash', () => ({ isGitBashAvailable: isGitBashAvailableMock }))
vi.mock('../shared/child-process/run-process', () => ({ runProcess: runProcessMock }))

import { PreflightHandler } from './preflight-handler'
import {
  buildCommandLookupSpec,
  buildCommandLookupSpecs,
  hasAbsoluteCommandPath,
  isCommandOnPathForRelay,
  resolveCommandPathsForRelay
} from './relay-command-path-lookup'

function lookupArgs(command: string, mode: '-lc' | '-ilc' = '-lc'): string[] {
  return [
    mode,
    [
      buildPosixCommandPathLookupScript({ kind: 'literal', value: command }),
      'if [ -n "$resolved" ]; then',
      'printf \'__ORCA_AGENT_PATH__%s\\n\' "$resolved"',
      'fi'
    ].join('\n')
  ]
}

function fishLookupArgs(command: string): string[] {
  return [
    '-ilc',
    [
      `set -l resolved (command -v ${command} 2>/dev/null)`,
      'if test -n "$resolved"',
      'printf \'__ORCA_AGENT_PATH__%s\\n\' "$resolved"',
      'end'
    ].join('\n')
  ]
}

beforeEach(() => {
  execFileAsyncMock.mockReset()
  runProcessMock.mockReset()
  isPwshAvailableAsyncMock.mockReset()
  isWslAvailableAsyncMock.mockReset()
  listWslDistrosAsyncMock.mockReset()
  isGitBashAvailableMock.mockReset()
})

describe('buildCommandLookupSpec', () => {
  it('uses where.exe on native Windows SSH hosts', () => {
    expect(buildCommandLookupSpec('codex', 'win32')).toEqual({
      file: 'where.exe',
      args: ['codex'],
      windowsHide: true
    })
  })

  it('falls back to sh for POSIX probes without a configured shell', () => {
    expect(buildCommandLookupSpec('codex', 'linux', {}, null)).toEqual({
      file: '/bin/sh',
      args: lookupArgs('codex')
    })
  })

  it('uses the configured remote shell for POSIX probes', () => {
    expect(buildCommandLookupSpec('codex', 'linux', { SHELL: '/bin/zsh' }, '/bin/zsh')).toEqual({
      file: '/bin/zsh',
      args: lookupArgs('codex', '-ilc')
    })
  })

  it('quotes command names in shell probes', () => {
    expect(
      buildCommandLookupSpec("agent'cli", 'linux', { SHELL: '/bin/bash' }, '/bin/bash')
    ).toEqual({
      file: '/bin/bash',
      args: lookupArgs("agent'cli", '-ilc')
    })
  })
})

describe('buildCommandLookupSpecs', () => {
  it('falls back to inherited PATH after a trusted configured POSIX shell', () => {
    expect(buildCommandLookupSpecs('codex', 'linux', { SHELL: '/bin/zsh' }, '/bin/zsh')).toEqual([
      { file: '/bin/zsh', args: lookupArgs('codex', '-ilc') },
      { file: '/bin/sh', args: lookupArgs('codex') }
    ])
  })

  it('allows a custom shell path only when the account login shell matches', () => {
    expect(
      buildCommandLookupSpecs(
        'codex',
        'darwin',
        { SHELL: '/opt/homebrew/bin/zsh' },
        '/opt/homebrew/bin/zsh'
      )
    ).toEqual([
      { file: '/opt/homebrew/bin/zsh', args: lookupArgs('codex', '-ilc') },
      { file: '/bin/sh', args: lookupArgs('codex') }
    ])
  })

  it('allows conservative system shell paths when account lookup is unavailable', () => {
    expect(buildCommandLookupSpecs('codex', 'linux', { SHELL: '/usr/bin/bash' }, null)[0]).toEqual({
      file: '/usr/bin/bash',
      args: lookupArgs('codex', '-ilc')
    })
  })

  it('uses fish syntax for trusted fish shells', () => {
    expect(buildCommandLookupSpecs('codex', 'linux', { SHELL: '/usr/bin/fish' }, null)[0]).toEqual({
      file: '/usr/bin/fish',
      args: fishLookupArgs("'codex'")
    })
  })

  it('ignores untrusted temp shell paths even when the basename is supported', () => {
    expect(buildCommandLookupSpecs('codex', 'linux', { SHELL: '/tmp/zsh' }, '/bin/bash')).toEqual([
      { file: '/bin/sh', args: lookupArgs('codex') }
    ])
  })

  it('ignores untrusted home-bin shell paths even when the basename is supported', () => {
    expect(
      buildCommandLookupSpecs('codex', 'linux', { SHELL: '/home/test/bin/bash' }, '/bin/bash')
    ).toEqual([{ file: '/bin/sh', args: lookupArgs('codex') }])
  })
})

describe('isCommandOnPathForRelay', () => {
  it('falls back to inherited PATH when shell startup returns no absolute command path', async () => {
    execFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'welcome\ncodex is a function\n' })
      .mockResolvedValueOnce({ stdout: '__ORCA_AGENT_PATH__/relay/path/codex\n' })

    await expect(
      isCommandOnPathForRelay('codex', {
        platform: 'linux',
        env: { SHELL: '/bin/zsh', PATH: '/usr/bin' },
        accountLoginShell: '/bin/zsh'
      })
    ).resolves.toBe(true)
    expect(execFileAsyncMock).toHaveBeenNthCalledWith(1, '/bin/zsh', lookupArgs('codex', '-ilc'), {
      encoding: 'utf-8',
      env: expect.objectContaining({ SHELL: '/bin/zsh', ORCA_SHELL_PATH_PROBE: '1' }),
      timeout: 5000
    })
    expect(execFileAsyncMock).toHaveBeenNthCalledWith(2, '/bin/sh', lookupArgs('codex'), {
      encoding: 'utf-8',
      env: expect.objectContaining({ SHELL: '/bin/zsh' }),
      timeout: 5000
    })
  })

  it('falls back to inherited PATH when shell startup fails', async () => {
    execFileAsyncMock
      .mockRejectedValueOnce(new Error('startup failed'))
      .mockResolvedValueOnce({ stdout: '__ORCA_AGENT_PATH__/relay/path/codex\n' })

    await expect(
      isCommandOnPathForRelay('codex', {
        platform: 'linux',
        env: { SHELL: '/bin/bash', PATH: '/usr/bin' },
        accountLoginShell: '/bin/bash'
      })
    ).resolves.toBe(true)
    expect(execFileAsyncMock).toHaveBeenCalledTimes(2)
  })

  it('does not execute an untrusted configured shell before inherited PATH lookup', async () => {
    execFileAsyncMock.mockResolvedValueOnce({ stdout: '__ORCA_AGENT_PATH__/relay/path/codex\n' })

    await expect(
      isCommandOnPathForRelay('codex', {
        platform: 'linux',
        env: { SHELL: '/tmp/zsh', PATH: '/usr/bin' },
        accountLoginShell: '/bin/bash'
      })
    ).resolves.toBe(true)
    expect(execFileAsyncMock).toHaveBeenCalledTimes(1)
    expect(execFileAsyncMock).toHaveBeenCalledWith('/bin/sh', lookupArgs('codex'), {
      encoding: 'utf-8',
      env: expect.objectContaining({ SHELL: '/tmp/zsh' }),
      timeout: 5000
    })
  })
})

describe('resolveCommandPathsForRelay', () => {
  it('resolves every command with one login shell instead of one shell per command', async () => {
    execFileAsyncMock.mockResolvedValueOnce({
      stdout:
        '__ORCA_AGENT_PATH__claude\t/opt/bin/claude\n__ORCA_AGENT_PATH__codex\t/opt/bin/codex\n'
    })

    const resolved = await resolveCommandPathsForRelay(['claude', 'codex', 'claude'], {
      platform: 'darwin',
      env: { SHELL: '/bin/zsh', PATH: '/usr/bin' },
      accountLoginShell: '/bin/zsh'
    })

    expect(Object.fromEntries(resolved)).toEqual({
      claude: '/opt/bin/claude',
      codex: '/opt/bin/codex'
    })
    expect(execFileAsyncMock).toHaveBeenCalledTimes(1)
    const [file, args, options] = execFileAsyncMock.mock.calls[0]
    expect(file).toBe('/bin/zsh')
    expect(args[0]).toBe('-ilc')
    expect(args[1]).toContain("for _orca_agent_cmd in 'claude' 'codex'; do")
    expect(options).toEqual({
      encoding: 'utf-8',
      env: expect.objectContaining({ ORCA_SHELL_PATH_PROBE: '1' }),
      timeout: 5000,
      windowsHide: true
    })
  })

  it('retries only the commands the login shell missed with the inherited-PATH shell', async () => {
    execFileAsyncMock
      .mockResolvedValueOnce({ stdout: '__ORCA_AGENT_PATH__claude\t/opt/bin/claude\n' })
      .mockResolvedValueOnce({ stdout: '__ORCA_AGENT_PATH__codex\t/usr/local/bin/codex\n' })

    const resolved = await resolveCommandPathsForRelay(['claude', 'codex', 'gemini'], {
      platform: 'linux',
      env: { SHELL: '/bin/bash', PATH: '/usr/bin' },
      accountLoginShell: '/bin/bash'
    })

    expect(Object.fromEntries(resolved)).toEqual({
      claude: '/opt/bin/claude',
      codex: '/usr/local/bin/codex',
      gemini: null
    })
    expect(execFileAsyncMock).toHaveBeenCalledTimes(2)
    const [fallbackFile, fallbackArgs] = execFileAsyncMock.mock.calls[1]
    expect(fallbackFile).toBe('/bin/sh')
    expect(fallbackArgs[0]).toBe('-lc')
    expect(fallbackArgs[1]).toContain("for _orca_agent_cmd in 'codex' 'gemini'; do")
  })

  it('skips the fallback shell once the login shell resolved everything', async () => {
    execFileAsyncMock.mockResolvedValueOnce({
      stdout: '__ORCA_AGENT_PATH__claude\t/opt/bin/claude\n'
    })

    await resolveCommandPathsForRelay(['claude'], {
      platform: 'linux',
      env: { SHELL: '/bin/zsh' },
      accountLoginShell: '/bin/zsh'
    })

    expect(execFileAsyncMock).toHaveBeenCalledTimes(1)
  })

  it('falls back to the inherited-PATH shell when the login shell fails to start', async () => {
    execFileAsyncMock
      .mockRejectedValueOnce(new Error('startup failed'))
      .mockResolvedValueOnce({ stdout: '__ORCA_AGENT_PATH__codex\t/usr/bin/codex\n' })

    const resolved = await resolveCommandPathsForRelay(['codex'], {
      platform: 'linux',
      env: { SHELL: '/bin/zsh' },
      accountLoginShell: '/bin/zsh'
    })

    expect(resolved.get('codex')).toBe('/usr/bin/codex')
  })

  it('ignores banners, unrequested commands, and non-absolute paths', async () => {
    execFileAsyncMock.mockResolvedValueOnce({
      stdout: [
        'welcome to the host',
        '__ORCA_AGENT_PATH__claude\trelative/claude',
        '__ORCA_AGENT_PATH__intruder\t/tmp/intruder',
        '__ORCA_AGENT_PATH__codex\t/opt/bin/codex',
        '__ORCA_AGENT_PATH__codex\t/second/codex',
        '__ORCA_AGENT_PATH__/no/separator'
      ].join('\n')
    })

    const resolved = await resolveCommandPathsForRelay(['claude', 'codex'], {
      platform: 'linux',
      env: {},
      accountLoginShell: null
    })

    expect(Object.fromEntries(resolved)).toEqual({ claude: null, codex: '/opt/bin/codex' })
  })

  it('uses fish syntax for a trusted fish login shell', async () => {
    execFileAsyncMock.mockResolvedValueOnce({
      stdout: '__ORCA_AGENT_PATH__codex\t/opt/bin/codex\n'
    })

    await resolveCommandPathsForRelay(['codex'], {
      platform: 'linux',
      env: { SHELL: '/usr/bin/fish' },
      accountLoginShell: null
    })

    const [file, args] = execFileAsyncMock.mock.calls[0]
    expect(file).toBe('/usr/bin/fish')
    expect(args).toEqual([
      '-ilc',
      [
        "for _orca_agent_cmd in 'codex'",
        'set -l resolved (command -v $_orca_agent_cmd 2>/dev/null)',
        'if test -n "$resolved"',
        'printf \'__ORCA_AGENT_PATH__%s\\t%s\\n\' $_orca_agent_cmd "$resolved"',
        'end',
        'end'
      ].join('\n')
    ])
  })

  it('keeps per-command where.exe lookups on native Windows SSH hosts', async () => {
    execFileAsyncMock.mockImplementation(async (_file, args) => {
      if (String(args[0]) === 'claude') {
        return { stdout: 'C:\\Users\\test\\AppData\\Roaming\\npm\\claude.cmd\r\n' }
      }
      throw new Error('not found')
    })

    const resolved = await resolveCommandPathsForRelay(['claude', 'codex'], { platform: 'win32' })

    expect(Object.fromEntries(resolved)).toEqual({
      claude: 'C:\\Users\\test\\AppData\\Roaming\\npm\\claude.cmd',
      codex: null
    })
    expect(execFileAsyncMock).toHaveBeenCalledTimes(2)
    expect(execFileAsyncMock).toHaveBeenCalledWith('where.exe', ['claude'], expect.anything())
  })
})

describe('hasAbsoluteCommandPath', () => {
  it('ignores banners and shell function output', () => {
    expect(hasAbsoluteCommandPath('/tmp/not-the-agent\ncodex is a shell function\n', 'linux')).toBe(
      false
    )
  })

  it('ignores unmarked POSIX absolute paths from shell startup output', () => {
    expect(hasAbsoluteCommandPath('/tmp/not-the-agent\n', 'linux')).toBe(false)
  })

  it('recognizes a sentinel-marked command path amid shell startup and exit output', () => {
    expect(
      hasAbsoluteCommandPath('welcome\n__ORCA_AGENT_PATH__/opt/bin/codex\nlogout-banner\n', 'linux')
    ).toBe(true)
  })

  it('recognizes Windows absolute command paths', () => {
    expect(
      hasAbsoluteCommandPath('C:\\Users\\alice\\AppData\\Roaming\\npm\\codex.cmd\r\n', 'win32')
    ).toBe(true)
  })
})

describe('PreflightHandler', () => {
  it('reports a requested version from the resolved execution-host binary', async () => {
    execFileAsyncMock.mockResolvedValue({
      stdout: '__ORCA_AGENT_PATH__claude\t/home/dev/.local/bin/claude\n'
    })
    runProcessMock.mockResolvedValue({
      code: 0,
      signal: null,
      stdout: '2.1.261 (Claude Code)\n',
      stderr: '',
      timedOut: false
    })
    const requestHandlers = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>()
    const dispatcher = {
      onRequest: vi.fn(
        (method: string, handler: (params: Record<string, unknown>) => Promise<unknown>) => {
          requestHandlers.set(method, handler)
        }
      )
    }
    new PreflightHandler(dispatcher as never)

    await expect(
      requestHandlers.get('preflight.detectAgents')!({
        commands: [{ id: 'claude', cmd: 'claude', reportVersion: true }]
      })
    ).resolves.toEqual({
      agents: ['claude'],
      versions: { claude: '2.1.261 (Claude Code)' }
    })
    expect(runProcessMock).toHaveBeenCalledWith(
      expect.objectContaining({
        program: '/home/dev/.local/bin/claude',
        args: ['--version']
      })
    )
  })

  it('probes every agent CLI through a single shell per lookup stage', async () => {
    const originalShell = process.env.SHELL
    process.env.SHELL = '/bin/sh'
    execFileAsyncMock.mockResolvedValue({ stdout: '__ORCA_AGENT_PATH__claude\t/opt/bin/claude\n' })
    const requestHandlers = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>()
    const dispatcher = {
      onRequest: vi.fn(
        (method: string, handler: (params: Record<string, unknown>) => Promise<unknown>) => {
          requestHandlers.set(method, handler)
        }
      )
    }
    new PreflightHandler(dispatcher as never)
    const commands = Array.from({ length: 40 }, (_, index) => ({
      id: `agent-${index}`,
      cmd: `agent-${index}`
    }))

    try {
      await expect(
        requestHandlers.get('preflight.detectAgents')!({
          commands: [...commands, { id: 'claude', cmd: 'claude' }]
        })
      ).resolves.toEqual({ agents: ['claude'] })
      expect(execFileAsyncMock).toHaveBeenCalledTimes(1)
    } finally {
      if (originalShell === undefined) {
        delete process.env.SHELL
      } else {
        process.env.SHELL = originalShell
      }
    }
  })

  it('honors required commands when reporting detected agents', async () => {
    execFileAsyncMock.mockResolvedValue({ stdout: '__ORCA_AGENT_PATH__orca\t/relay/path/orca\n' })
    const requestHandlers = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>()
    const dispatcher = {
      onRequest: vi.fn(
        (method: string, handler: (params: Record<string, unknown>) => Promise<unknown>) => {
          requestHandlers.set(method, handler)
        }
      )
    }

    new PreflightHandler(dispatcher as never)

    const handler = requestHandlers.get('preflight.detectAgents')
    expect(handler).toBeDefined()
    await expect(
      handler!({
        commands: [
          { id: 'claude-agent-teams', cmd: 'orca', requiredCommands: ['claude'] },
          { id: 'claude', cmd: 'claude' }
        ]
      })
    ).resolves.toEqual({ agents: [] })
  })

  it('does not report platform-unsupported agents on native Windows SSH hosts', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })
    execFileAsyncMock.mockImplementation(async (_file, args) => {
      if (String(args[0]) === 'claude') {
        return { stdout: 'C:\\Users\\test\\AppData\\Roaming\\npm\\claude.cmd\r\n' }
      }
      if (String(args[0]) === 'orca') {
        return { stdout: 'C:\\Program Files\\Orca\\orca.cmd\r\n' }
      }
      throw new Error('not found')
    })
    const requestHandlers = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>()
    const dispatcher = {
      onRequest: vi.fn(
        (method: string, handler: (params: Record<string, unknown>) => Promise<unknown>) => {
          requestHandlers.set(method, handler)
        }
      )
    }

    try {
      new PreflightHandler(dispatcher as never)
      const handler = requestHandlers.get('preflight.detectAgents')
      expect(handler).toBeDefined()
      await expect(
        handler!({
          commands: [
            {
              id: 'claude-agent-teams',
              cmd: 'orca',
              requiredCommands: ['claude'],
              unsupportedRuntimes: ['win32']
            },
            { id: 'claude', cmd: 'claude' }
          ]
        })
      ).resolves.toEqual({ agents: ['claude'] })
    } finally {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform
      })
    }
  })

  it('reports remote Windows shell capabilities through the SSH preflight path', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })
    isWslAvailableAsyncMock.mockResolvedValue(true)
    listWslDistrosAsyncMock.mockResolvedValue(['Ubuntu'])
    isPwshAvailableAsyncMock.mockResolvedValue(true)
    isGitBashAvailableMock.mockReturnValue(true)

    const requestHandlers = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>()
    const dispatcher = {
      onRequest: vi.fn(
        (method: string, handler: (params: Record<string, unknown>) => Promise<unknown>) => {
          requestHandlers.set(method, handler)
        }
      )
    }

    new PreflightHandler(dispatcher as never)

    try {
      const handler = requestHandlers.get('preflight.detectWindowsTerminalCapabilities')
      expect(handler).toBeDefined()
      await expect(handler!({})).resolves.toEqual({
        wslAvailable: true,
        wslDistros: ['Ubuntu'],
        pwshAvailable: true,
        gitBashAvailable: true,
        hostPlatform: 'win32'
      })
    } finally {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform
      })
    }
  })
})
