/* eslint-disable max-lines -- Why: preflight tests share expensive process/preload mocks across
   install, auth, agent detection, and refresh branches. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  handleMock,
  execFileMock,
  execFileAsyncMock,
  hydrateShellPathMock,
  mergePathSegmentsMock,
  getActiveMultiplexerMock,
  getBitbucketAuthStatusMock,
  getAzureDevOpsAuthStatusMock,
  getGiteaAuthStatusMock
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  execFileMock: vi.fn(),
  execFileAsyncMock: vi.fn(),
  hydrateShellPathMock: vi.fn(),
  mergePathSegmentsMock: vi.fn(),
  getActiveMultiplexerMock: vi.fn(),
  getBitbucketAuthStatusMock: vi.fn(),
  getAzureDevOpsAuthStatusMock: vi.fn(),
  getGiteaAuthStatusMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: handleMock
  }
}))

vi.mock('child_process', () => {
  const execFileWithPromisify = Object.assign(execFileMock, {
    [Symbol.for('nodejs.util.promisify.custom')]: execFileAsyncMock
  })
  return {
    execFile: execFileWithPromisify,
    spawn: vi.fn()
  }
})

vi.mock('../startup/hydrate-shell-path', () => ({
  hydrateShellPath: hydrateShellPathMock,
  mergePathSegments: mergePathSegmentsMock
}))

vi.mock('./ssh', () => ({
  getActiveMultiplexer: getActiveMultiplexerMock
}))

vi.mock('../bitbucket/client', () => ({
  getBitbucketAuthStatus: getBitbucketAuthStatusMock
}))

vi.mock('../azure-devops/client', () => ({
  getAzureDevOpsAuthStatus: getAzureDevOpsAuthStatusMock
}))

vi.mock('../gitea/client', () => ({
  getGiteaAuthStatus: getGiteaAuthStatusMock
}))

import {
  _resetPreflightCache,
  detectInstalledAgents,
  registerPreflightHandlers,
  runPreflightCheck
} from './preflight'

type HandlerMap = Record<string, (_event?: unknown, args?: unknown) => Promise<unknown>>

describe('preflight', () => {
  const originalPlatform = process.platform
  const handlers: HandlerMap = {}
  const defaultBitbucketStatus = { configured: false, authenticated: false, account: null }
  const defaultAzureDevOpsStatus = {
    configured: false,
    authenticated: false,
    account: null,
    baseUrl: null,
    tokenConfigured: false
  }
  const defaultGiteaStatus = {
    configured: false,
    authenticated: false,
    account: null,
    baseUrl: null,
    tokenConfigured: false
  }

  beforeEach(() => {
    handleMock.mockReset()
    execFileAsyncMock.mockReset()
    hydrateShellPathMock.mockReset()
    mergePathSegmentsMock.mockReset()
    getActiveMultiplexerMock.mockReset()
    getBitbucketAuthStatusMock.mockReset()
    getAzureDevOpsAuthStatusMock.mockReset()
    getGiteaAuthStatusMock.mockReset()
    getBitbucketAuthStatusMock.mockResolvedValue(defaultBitbucketStatus)
    getAzureDevOpsAuthStatusMock.mockResolvedValue(defaultAzureDevOpsStatus)
    getGiteaAuthStatusMock.mockResolvedValue(defaultGiteaStatus)
    _resetPreflightCache()
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'darwin'
    })

    for (const key of Object.keys(handlers)) {
      delete handlers[key]
    }

    handleMock.mockImplementation((channel, handler) => {
      handlers[channel] = handler
    })
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: originalPlatform
    })
  })

  // Why: every preflight run probes (in order) `git --version`, `gh --version`,
  // `glab --version`, then in parallel `gh auth status` + `glab auth status` —
  // five execFile calls per cycle. Tests below provide values for all five.
  it('marks gh as authenticated when gh auth status exits successfully', async () => {
    execFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'git version 2.0.0\n' })
      .mockResolvedValueOnce({ stdout: 'gh version 2.0.0\n' })
      .mockResolvedValueOnce({ stdout: 'glab version 1.92.1\n' })
      .mockResolvedValueOnce({ stdout: 'github.com\n  - Active account: true\n' })
      .mockResolvedValueOnce({ stdout: 'Logged in to gitlab.com\n' })

    const status = await runPreflightCheck()

    expect(status).toEqual({
      git: { installed: true },
      gh: { installed: true, authenticated: true },
      glab: { installed: true, authenticated: true },
      bitbucket: defaultBitbucketStatus,
      azureDevOps: defaultAzureDevOpsStatus,
      gitea: defaultGiteaStatus
    })
    expect(execFileAsyncMock).toHaveBeenNthCalledWith(4, 'gh', ['auth', 'status'], {
      encoding: 'utf-8',
      timeout: 5000
    })
    expect(execFileAsyncMock).toHaveBeenNthCalledWith(5, 'glab', ['auth', 'status'], {
      encoding: 'utf-8',
      timeout: 5000
    })
  })

  it('treats gh as unauthenticated when gh auth status fails without auth markers', async () => {
    execFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'git version 2.0.0\n' })
      .mockResolvedValueOnce({ stdout: 'gh version 2.0.0\n' })
      .mockResolvedValueOnce({ stdout: 'glab version 1.92.1\n' })
      .mockRejectedValueOnce({ stderr: 'You are not logged into any GitHub hosts.\n' })
      .mockResolvedValueOnce({ stdout: 'Logged in to gitlab.com\n' })

    const status = await runPreflightCheck()

    expect(status.gh).toEqual({ installed: true, authenticated: false })
  })

  it('keeps older gh stderr success output from showing a false auth warning', async () => {
    execFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'git version 2.0.0\n' })
      .mockResolvedValueOnce({ stdout: 'gh version 2.0.0\n' })
      .mockResolvedValueOnce({ stdout: 'glab version 1.92.1\n' })
      .mockRejectedValueOnce({ stderr: 'Logged in to github.com account octocat\n' })
      .mockResolvedValueOnce({ stdout: 'Logged in to gitlab.com\n' })

    const status = await runPreflightCheck()

    expect(status.gh).toEqual({ installed: true, authenticated: true })
  })

  it('marks glab as not installed when `glab --version` fails', async () => {
    execFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'git version 2.0.0\n' })
      .mockResolvedValueOnce({ stdout: 'gh version 2.0.0\n' })
      .mockRejectedValueOnce(new Error('command not found: glab'))
      .mockResolvedValueOnce({ stdout: 'github.com\n  - Active account: true\n' })

    const status = await runPreflightCheck()

    expect(status.glab).toEqual({ installed: false, authenticated: false })
    // Why: with glab uninstalled, glab auth status must not run — that
    // would surface a misleading "command not found" error in logs.
    expect(execFileAsyncMock).toHaveBeenCalledTimes(4)
  })

  it('marks glab as installed but unauthenticated when auth status fails', async () => {
    execFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'git version 2.0.0\n' })
      .mockResolvedValueOnce({ stdout: 'gh version 2.0.0\n' })
      .mockResolvedValueOnce({ stdout: 'glab version 1.92.1\n' })
      .mockResolvedValueOnce({ stdout: 'github.com\n  - Active account: true\n' })
      .mockRejectedValueOnce({ stderr: 'You are not logged into any GitLab hosts.\n' })

    const status = await runPreflightCheck()

    expect(status.glab).toEqual({ installed: true, authenticated: false })
  })

  it('times out hung local preflight probes', async () => {
    vi.useFakeTimers()
    try {
      execFileAsyncMock.mockImplementation((command, args) => {
        if (command === 'git') {
          return Promise.resolve({ stdout: 'git version 2.0.0\n' })
        }
        if (command === 'gh' && Array.isArray(args) && args[0] === '--version') {
          return new Promise(() => {})
        }
        if (command === 'glab') {
          return Promise.reject(new Error('command not found: glab'))
        }
        throw new Error(`unexpected command ${String(command)}`)
      })

      const statusPromise = runPreflightCheck()
      let settled = false
      void statusPromise.then(
        () => {
          settled = true
        },
        () => {
          settled = true
        }
      )

      await vi.advanceTimersByTimeAsync(5000)
      await Promise.resolve()

      expect(settled).toBe(true)
      await expect(statusPromise).resolves.toMatchObject({
        git: { installed: true },
        gh: { installed: false },
        glab: { installed: false }
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('prefers the selected WSL distro when checking gh for a WSL workspace', async () => {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })
    execFileAsyncMock.mockImplementation(async (command, args) => {
      if (command === 'git') {
        return { stdout: 'git version 2.0.0\n' }
      }
      if (command === 'gh') {
        throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' })
      }
      if (command === 'glab') {
        throw Object.assign(new Error('spawn glab ENOENT'), { code: 'ENOENT' })
      }
      if (command === 'wsl.exe') {
        const script = String(args[5])
        if (script === "'gh' --version") {
          return { stdout: 'gh version 2.0.0\n' }
        }
        if (script === "'gh' auth status") {
          return { stdout: 'github.com\n  - Active account: true\n' }
        }
        throw new Error(`unexpected WSL script ${script}`)
      }
      throw new Error(`unexpected command ${String(command)}`)
    })

    const status = await runPreflightCheck(false, { wslDistro: 'Ubuntu' })

    expect(status.gh).toEqual({ installed: true, authenticated: true })
    expect(execFileAsyncMock).toHaveBeenCalledWith(
      'wsl.exe',
      ['-d', 'Ubuntu', '--', 'bash', '-lc', "'gh' --version"],
      { encoding: 'utf-8', timeout: 5000 }
    )
    expect(execFileAsyncMock).toHaveBeenCalledWith(
      'wsl.exe',
      ['-d', 'Ubuntu', '--', 'bash', '-lc', "'gh' auth status"],
      { encoding: 'utf-8', timeout: 5000 }
    )
  })

  it('times out hung WSL preflight probes', async () => {
    vi.useFakeTimers()
    try {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: 'win32'
      })
      execFileAsyncMock.mockImplementation((command, args) => {
        if (command === 'git') {
          return Promise.resolve({ stdout: 'git version 2.0.0\n' })
        }
        if (command === 'gh' || command === 'glab') {
          return Promise.reject(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))
        }
        if (command === 'wsl.exe' && Array.isArray(args) && args.at(-1) === "'gh' --version") {
          return new Promise(() => {})
        }
        if (command === 'wsl.exe' && Array.isArray(args) && args.at(-1) === "'glab' --version") {
          return Promise.reject(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))
        }
        throw new Error(`unexpected command ${String(command)}`)
      })

      const statusPromise = runPreflightCheck(false, { wslDistro: 'Ubuntu' })
      let settled = false
      void statusPromise.finally(() => {
        settled = true
      })

      await vi.advanceTimersByTimeAsync(5000)
      await Promise.resolve()

      expect(settled).toBe(true)
      await expect(statusPromise).resolves.toMatchObject({
        gh: { installed: false },
        glab: { installed: false }
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('re-runs the probe when forced so updated gh auth state is visible without relaunch', async () => {
    execFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'git version 2.0.0\n' })
      .mockResolvedValueOnce({ stdout: 'gh version 2.0.0\n' })
      .mockResolvedValueOnce({ stdout: 'glab version 1.92.1\n' })
      .mockRejectedValueOnce({ stderr: 'You are not logged into any GitHub hosts.\n' })
      .mockResolvedValueOnce({ stdout: 'Logged in to gitlab.com\n' })
      .mockResolvedValueOnce({ stdout: 'git version 2.0.0\n' })
      .mockResolvedValueOnce({ stdout: 'gh version 2.0.0\n' })
      .mockResolvedValueOnce({ stdout: 'glab version 1.92.1\n' })
      .mockResolvedValueOnce({ stdout: 'github.com\n  - Active account: true\n' })
      .mockResolvedValueOnce({ stdout: 'Logged in to gitlab.com\n' })

    const firstStatus = await runPreflightCheck()
    const refreshedStatus = await runPreflightCheck(true)

    expect(firstStatus.gh).toEqual({ installed: true, authenticated: false })
    expect(refreshedStatus.gh).toEqual({ installed: true, authenticated: true })
    expect(execFileAsyncMock).toHaveBeenCalledTimes(10)
  })

  it('registers the preflight handler', async () => {
    execFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'git version 2.0.0\n' })
      .mockResolvedValueOnce({ stdout: 'gh version 2.0.0\n' })
      .mockResolvedValueOnce({ stdout: 'glab version 1.92.1\n' })
      .mockResolvedValueOnce({ stdout: 'github.com\n' })
      .mockResolvedValueOnce({ stdout: 'Logged in to gitlab.com\n' })

    registerPreflightHandlers()

    const status = await handlers['preflight:check']()

    expect(status).toEqual({
      git: { installed: true },
      gh: { installed: true, authenticated: true },
      glab: { installed: true, authenticated: true },
      bitbucket: defaultBitbucketStatus,
      azureDevOps: defaultAzureDevOpsStatus,
      gitea: defaultGiteaStatus
    })
  })

  it('lets the IPC handler bypass the session cache when forced', async () => {
    execFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'git version 2.0.0\n' })
      .mockResolvedValueOnce({ stdout: 'gh version 2.0.0\n' })
      .mockResolvedValueOnce({ stdout: 'glab version 1.92.1\n' })
      .mockRejectedValueOnce({ stderr: 'You are not logged into any GitHub hosts.\n' })
      .mockResolvedValueOnce({ stdout: 'Logged in to gitlab.com\n' })
      .mockResolvedValueOnce({ stdout: 'git version 2.0.0\n' })
      .mockResolvedValueOnce({ stdout: 'gh version 2.0.0\n' })
      .mockResolvedValueOnce({ stdout: 'glab version 1.92.1\n' })
      .mockResolvedValueOnce({ stdout: 'github.com\n  - Active account: true\n' })
      .mockResolvedValueOnce({ stdout: 'Logged in to gitlab.com\n' })

    registerPreflightHandlers()

    const firstStatus = await handlers['preflight:check']()
    const refreshedStatus = await handlers['preflight:check'](null, { force: true })

    expect(firstStatus).toEqual({
      git: { installed: true },
      gh: { installed: true, authenticated: false },
      glab: { installed: true, authenticated: true },
      bitbucket: defaultBitbucketStatus,
      azureDevOps: defaultAzureDevOpsStatus,
      gitea: defaultGiteaStatus
    })
    expect(refreshedStatus).toEqual({
      git: { installed: true },
      gh: { installed: true, authenticated: true },
      glab: { installed: true, authenticated: true },
      bitbucket: defaultBitbucketStatus,
      azureDevOps: defaultAzureDevOpsStatus,
      gitea: defaultGiteaStatus
    })
  })

  it('only reports agents when which/where resolves to a real executable path', async () => {
    execFileAsyncMock.mockImplementation(async (command, args) => {
      if (command !== 'which') {
        throw new Error(`unexpected command ${String(command)}`)
      }

      const target = String(args[0])
      if (target === 'claude') {
        return { stdout: '/Users/test/.local/bin/claude\n' }
      }
      if (target === 'continue') {
        return { stdout: 'continue: shell built-in command\n' }
      }
      if (target === 'cursor-agent') {
        return { stdout: '/Users/test/.local/bin/cursor-agent\n' }
      }
      throw new Error('not found')
    })

    await expect(detectInstalledAgents()).resolves.toEqual(['claude', 'cursor'])
  })

  it('registers agent detection through the shared launch config commands', async () => {
    execFileAsyncMock.mockImplementation(async (command, args) => {
      if (command !== 'which') {
        throw new Error(`unexpected command ${String(command)}`)
      }
      if (String(args[0]) === 'openclaude') {
        return { stdout: '/Users/test/.local/bin/openclaude\n' }
      }
      if (String(args[0]) === 'cursor-agent') {
        return { stdout: '/Users/test/.local/bin/cursor-agent\n' }
      }
      throw new Error('not found')
    })

    registerPreflightHandlers()

    await expect(handlers['preflight:detectAgents']()).resolves.toEqual(['openclaude', 'cursor'])
  })

  it('sends OpenClaude detection commands through the SSH remote preflight path', async () => {
    const request = vi.fn().mockResolvedValue({ agents: ['openclaude'] })
    getActiveMultiplexerMock.mockReturnValue({
      isDisposed: () => false,
      request
    })

    registerPreflightHandlers()

    await expect(
      handlers['preflight:detectRemoteAgents'](undefined, { connectionId: 'ssh-1' })
    ).resolves.toEqual(['openclaude'])
    expect(request).toHaveBeenCalledWith('preflight.detectAgents', {
      commands: expect.arrayContaining([{ id: 'openclaude', cmd: 'openclaude' }])
    })
  })

  it('detects agents from the selected WSL distro for a WSL workspace', async () => {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })
    execFileAsyncMock.mockImplementation(async (command, args) => {
      if (command === 'where') {
        throw new Error('not found')
      }
      if (command !== 'wsl.exe') {
        throw new Error(`unexpected command ${String(command)}`)
      }
      const script = String(args[5])
      if (script === "command -v 'claude'") {
        return { stdout: '/home/test/.local/bin/claude\n' }
      }
      throw new Error('not found')
    })

    await expect(detectInstalledAgents({ wslDistro: 'Ubuntu' })).resolves.toEqual(['claude'])
  })

  it('detects agents from the default WSL distro when requested', async () => {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })
    execFileAsyncMock.mockImplementation(async (command, args) => {
      if (command !== 'wsl.exe') {
        throw new Error(`unexpected command ${String(command)}`)
      }
      const script = String(args[3])
      if (script === "command -v 'codex'") {
        return { stdout: '/home/test/.local/bin/codex\n' }
      }
      throw new Error('not found')
    })

    await expect(detectInstalledAgents({ wslDefault: true })).resolves.toEqual(['codex'])
    expect(execFileAsyncMock).toHaveBeenCalledWith(
      'wsl.exe',
      ['--', 'bash', '-lc', "command -v 'codex'"],
      { encoding: 'utf-8', timeout: 5000 }
    )
  })

  it('refreshes via preflight:refreshAgents by re-hydrating PATH before re-detecting', async () => {
    // Why: the Agents settings Refresh button calls this path. It must (1) ask
    // the shell hydrator for a fresh PATH, (2) merge any new segments, then
    // (3) re-run `which` so newly-installed CLIs appear without a restart.
    hydrateShellPathMock.mockResolvedValueOnce({
      segments: ['/Users/test/.opencode/bin'],
      ok: true,
      failureReason: 'none'
    })
    mergePathSegmentsMock.mockReturnValueOnce(['/Users/test/.opencode/bin'])
    execFileAsyncMock.mockImplementation(async (command, args) => {
      if (command !== 'which') {
        throw new Error(`unexpected command ${String(command)}`)
      }
      if (String(args[0]) === 'opencode') {
        return { stdout: '/Users/test/.opencode/bin/opencode\n' }
      }
      throw new Error('not found')
    })

    registerPreflightHandlers()

    const result = (await handlers['preflight:refreshAgents']()) as {
      agents: string[]
      addedPathSegments: string[]
      shellHydrationOk: boolean
      pathSource: string
      pathFailureReason: string
    }

    expect(result).toEqual({
      agents: ['opencode'],
      addedPathSegments: ['/Users/test/.opencode/bin'],
      shellHydrationOk: true,
      pathSource: 'shell_hydrate',
      pathFailureReason: 'none'
    })
    expect(hydrateShellPathMock).toHaveBeenCalledWith({ force: true })
  })

  it('still re-detects when the shell spawn fails — relies on the existing PATH', async () => {
    hydrateShellPathMock.mockResolvedValueOnce({
      segments: [],
      ok: false,
      failureReason: 'timeout'
    })
    execFileAsyncMock.mockImplementation(async (command, args) => {
      if (command !== 'which') {
        throw new Error(`unexpected command ${String(command)}`)
      }
      if (String(args[0]) === 'claude') {
        return { stdout: '/Users/test/.local/bin/claude\n' }
      }
      throw new Error('not found')
    })

    registerPreflightHandlers()

    const result = (await handlers['preflight:refreshAgents']()) as {
      agents: string[]
      addedPathSegments: string[]
      shellHydrationOk: boolean
      pathSource: string
      pathFailureReason: string
    }

    expect(result.shellHydrationOk).toBe(false)
    expect(result.addedPathSegments).toEqual([])
    expect(result.agents).toEqual(['claude'])
    // Why: drives the agent_picks `on_path:false` triage in dashboard 1562016.
    // Without these fields we cannot distinguish "hydration failed" from
    // "user genuinely doesn't have the binary."
    expect(result.pathSource).toBe('sync_seed_only')
    expect(result.pathFailureReason).toBe('timeout')
    // Why: when hydration fails, we must not call merge — nothing to merge —
    // otherwise we'd log a no-op "added 0 segments" event on every refresh.
    expect(mergePathSegmentsMock).not.toHaveBeenCalled()
  })

  it.each(['no_shell', 'spawn_error', 'empty_path'] as const)(
    'classifies pathFailureReason=%s when hydration reports it',
    async (failureReason) => {
      hydrateShellPathMock.mockResolvedValueOnce({ segments: [], ok: false, failureReason })
      execFileAsyncMock.mockRejectedValue(new Error('not found'))

      registerPreflightHandlers()

      const result = (await handlers['preflight:refreshAgents']()) as {
        pathSource: string
        pathFailureReason: string
      }

      expect(result.pathSource).toBe('sync_seed_only')
      expect(result.pathFailureReason).toBe(failureReason)
    }
  )
})
