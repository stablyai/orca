import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildPosixCommandPathLookupScript } from '../shared/posix-command-path-lookup'

const { execFileAsyncMock } = vi.hoisted(() => ({
  execFileAsyncMock: vi.fn()
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

import {
  buildCommandLookupSpec,
  buildCommandLookupSpecs,
  hasAbsoluteCommandPath,
  resolveRelayCommandPath,
  PreflightHandler
} from './preflight-handler'

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

describe('resolveRelayCommandPath', () => {
  it('falls back to inherited PATH when shell startup returns no absolute command path', async () => {
    execFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'welcome\ncodex is a function\n' })
      .mockResolvedValueOnce({ stdout: '__ORCA_AGENT_PATH__/relay/path/codex\n' })

    await expect(
      resolveRelayCommandPath('codex', {
        platform: 'linux',
        env: { SHELL: '/bin/zsh', PATH: '/usr/bin' },
        accountLoginShell: '/bin/zsh'
      })
    ).resolves.toBe('/relay/path/codex')
    expect(execFileAsyncMock).toHaveBeenNthCalledWith(1, '/bin/zsh', lookupArgs('codex', '-ilc'), {
      encoding: 'utf-8',
      env: expect.objectContaining({ SHELL: '/bin/zsh' }),
      timeout: 2000
    })
    expect(execFileAsyncMock).toHaveBeenNthCalledWith(2, '/bin/sh', lookupArgs('codex'), {
      encoding: 'utf-8',
      env: expect.objectContaining({ SHELL: '/bin/zsh' }),
      timeout: 2000
    })
  })

  it('falls back to inherited PATH when shell startup fails', async () => {
    execFileAsyncMock
      .mockRejectedValueOnce(new Error('startup failed'))
      .mockResolvedValueOnce({ stdout: '__ORCA_AGENT_PATH__/relay/path/codex\n' })

    await expect(
      resolveRelayCommandPath('codex', {
        platform: 'linux',
        env: { SHELL: '/bin/bash', PATH: '/usr/bin' },
        accountLoginShell: '/bin/bash'
      })
    ).resolves.toBe('/relay/path/codex')
    expect(execFileAsyncMock).toHaveBeenCalledTimes(2)
  })

  it('does not execute an untrusted configured shell before inherited PATH lookup', async () => {
    execFileAsyncMock.mockResolvedValueOnce({ stdout: '__ORCA_AGENT_PATH__/relay/path/codex\n' })

    await expect(
      resolveRelayCommandPath('codex', {
        platform: 'linux',
        env: { SHELL: '/tmp/zsh', PATH: '/usr/bin' },
        accountLoginShell: '/bin/bash'
      })
    ).resolves.toBe('/relay/path/codex')
    expect(execFileAsyncMock).toHaveBeenCalledTimes(1)
    expect(execFileAsyncMock).toHaveBeenCalledWith('/bin/sh', lookupArgs('codex'), {
      encoding: 'utf-8',
      env: expect.objectContaining({ SHELL: '/tmp/zsh' }),
      timeout: 2000
    })
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
  it('honors required commands when reporting detected agents', async () => {
    execFileAsyncMock.mockImplementation(async (_file, args) => {
      const script = String(args[1])
      if (script.includes("'orca'")) {
        return { stdout: '__ORCA_AGENT_PATH__/relay/path/orca\n' }
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

// Why: spy on the prototype method rather than the underlying exec calls —
// install detection goes through platform-specific shell probing that's
// already covered by resolveRelayCommandPath's own tests.
type PreflightHandlerWithCommandProbe = {
  resolveCommandPath: (command: string) => Promise<string | null>
}

type ForgeCliDetectionResult = {
  results: Record<string, { installed: boolean; authenticated: boolean }>
}

function requestFromNewHandler(): (
  method: string,
  params: Record<string, unknown>
) => Promise<ForgeCliDetectionResult> {
  const requestHandlers = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>()
  const dispatcher = {
    onRequest: vi.fn(
      (method: string, handler: (params: Record<string, unknown>) => Promise<unknown>) => {
        requestHandlers.set(method, handler)
      }
    )
  }
  new PreflightHandler(dispatcher as never)
  return (method, params) => {
    const handler = requestHandlers.get(method)
    if (!handler) {
      throw new Error(`no handler registered for ${method}`)
    }
    return handler(params) as Promise<ForgeCliDetectionResult>
  }
}

describe('preflight.detectForgeClis', () => {
  let resolveCommandPathSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    resolveCommandPathSpy = vi.spyOn(
      PreflightHandler.prototype as unknown as PreflightHandlerWithCommandProbe,
      'resolveCommandPath'
    )
  })

  afterEach(() => {
    resolveCommandPathSpy.mockRestore()
  })

  it('probes install and auth for allowlisted forge CLIs', async () => {
    resolveCommandPathSpy.mockResolvedValue('/usr/local/bin/forge-cli')
    execFileAsyncMock.mockResolvedValueOnce({ stdout: '', stderr: '' })
    const request = requestFromNewHandler()

    const result = await request('preflight.detectForgeClis', { clis: ['glab'] })

    expect(result).toEqual({ results: { glab: { installed: true, authenticated: true } } })
    // Why: detection resolves through a login shell, so the auth probe must
    // spawn the resolved executable — a bare name would ENOENT whenever PATH
    // came from a shell startup file, reporting installed-but-unauthenticated.
    expect(execFileAsyncMock).toHaveBeenCalledWith(
      '/usr/local/bin/forge-cli',
      ['auth', 'status'],
      // Why: lookup + auth together must stay under the caller's 8s budget.
      expect.objectContaining({ timeout: 5_000 })
    )
  })

  it('treats non-zero auth exit with "Logged in" marker as authenticated', async () => {
    resolveCommandPathSpy.mockResolvedValue('/usr/local/bin/forge-cli')
    execFileAsyncMock.mockRejectedValueOnce({ stdout: '', stderr: 'Logged in as octocat\n' })
    const request = requestFromNewHandler()

    const result = await request('preflight.detectForgeClis', { clis: ['glab'] })

    expect(result.results.glab.authenticated).toBe(true)
  })

  // Why: execFile preserves stdout/stderr when `timeout` kills the child, so a
  // hung `auth status` that had already printed the marker must not read as a
  // yes. A killed probe is "unknown".
  it('rejects a timed-out auth probe even when partial output carries the marker', async () => {
    resolveCommandPathSpy.mockResolvedValue('/usr/local/bin/forge-cli')
    execFileAsyncMock.mockRejectedValueOnce({
      stdout: 'Logged in as octocat\n',
      stderr: '',
      killed: true,
      signal: 'SIGTERM'
    })
    const request = requestFromNewHandler()

    const result = await request('preflight.detectForgeClis', { clis: ['glab'] })

    expect(result.results.glab.authenticated).toBe(false)
  })

  it('treats gh "Active account: true" marker as authenticated', async () => {
    resolveCommandPathSpy.mockResolvedValue('/usr/local/bin/forge-cli')
    execFileAsyncMock.mockRejectedValueOnce({ stdout: '', stderr: 'Active account: true\n' })
    const request = requestFromNewHandler()

    const result = await request('preflight.detectForgeClis', { clis: ['gh'] })

    expect(result.results.gh.authenticated).toBe(true)
  })

  it('does not treat glab "Active account: true" marker as authenticated (gh-only marker)', async () => {
    resolveCommandPathSpy.mockResolvedValue('/usr/local/bin/forge-cli')
    execFileAsyncMock.mockRejectedValueOnce({ stdout: '', stderr: 'Active account: true\n' })
    const request = requestFromNewHandler()

    const result = await request('preflight.detectForgeClis', { clis: ['glab'] })

    expect(result.results.glab.authenticated).toBe(false)
  })

  it('reports an installed CLI that is not logged in as unauthenticated', async () => {
    resolveCommandPathSpy.mockResolvedValue('/usr/local/bin/forge-cli')
    execFileAsyncMock.mockRejectedValueOnce({ stdout: '', stderr: 'not logged in' })
    const request = requestFromNewHandler()

    const result = await request('preflight.detectForgeClis', { clis: ['gh'] })

    expect(result).toEqual({ results: { gh: { installed: true, authenticated: false } } })
  })

  it('probes each allowlisted CLI once regardless of duplicate requests', async () => {
    resolveCommandPathSpy.mockResolvedValue(null)
    const request = requestFromNewHandler()

    const result = await request('preflight.detectForgeClis', {
      clis: [...Array<string>(500).fill('gh'), 'glab', 'glab']
    })

    expect(resolveCommandPathSpy).toHaveBeenCalledTimes(2)
    expect(result).toEqual({
      results: {
        gh: { installed: false, authenticated: false },
        glab: { installed: false, authenticated: false }
      }
    })
  })

  it('reports not-installed without running auth', async () => {
    resolveCommandPathSpy.mockResolvedValue(null)
    const request = requestFromNewHandler()

    const result = await request('preflight.detectForgeClis', { clis: ['gh'] })

    expect(result).toEqual({ results: { gh: { installed: false, authenticated: false } } })
    expect(execFileAsyncMock).not.toHaveBeenCalled()
  })

  it('silently ignores non-allowlisted binaries', async () => {
    const request = requestFromNewHandler()

    const result = await request('preflight.detectForgeClis', {
      clis: ['bash', '../glab', 'gh; rm -rf /']
    })

    expect(result).toEqual({ results: {} })
    expect(resolveCommandPathSpy).not.toHaveBeenCalled()
    expect(execFileAsyncMock).not.toHaveBeenCalled()
  })
})
