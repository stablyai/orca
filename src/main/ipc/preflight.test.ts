import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock, execFileMock, execFileAsyncMock, hydrateShellPathMock, mergePathSegmentsMock } =
  vi.hoisted(() => ({
    handleMock: vi.fn(),
    execFileMock: vi.fn(),
    execFileAsyncMock: vi.fn(),
    hydrateShellPathMock: vi.fn(),
    mergePathSegmentsMock: vi.fn()
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

import {
  _resetPreflightCache,
  detectInstalledAgents,
  registerPreflightHandlers,
  runPreflightCheck
} from './preflight'

type HandlerMap = Record<string, (_event?: unknown, args?: { force?: boolean }) => Promise<unknown>>

describe('preflight', () => {
  const handlers: HandlerMap = {}

  beforeEach(() => {
    handleMock.mockReset()
    execFileAsyncMock.mockReset()
    hydrateShellPathMock.mockReset()
    mergePathSegmentsMock.mockReset()
    _resetPreflightCache()

    for (const key of Object.keys(handlers)) {
      delete handlers[key]
    }

    handleMock.mockImplementation((channel, handler) => {
      handlers[channel] = handler
    })
  })

  it('marks gh as authenticated when gh auth status exits successfully', async () => {
    execFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'git version 2.0.0\n' })
      .mockResolvedValueOnce({ stdout: 'gh version 2.0.0\n' })
      .mockResolvedValueOnce({ stdout: 'github.com\n  - Active account: true\n' })

    const status = await runPreflightCheck()

    expect(status).toEqual({
      git: { installed: true },
      gh: { installed: true, authenticated: true }
    })
    expect(execFileAsyncMock).toHaveBeenNthCalledWith(3, 'gh', ['auth', 'status'], {
      encoding: 'utf-8'
    })
  })

  it('treats gh as unauthenticated when gh auth status fails without auth markers', async () => {
    execFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'git version 2.0.0\n' })
      .mockResolvedValueOnce({ stdout: 'gh version 2.0.0\n' })
      .mockRejectedValueOnce({ stderr: 'You are not logged into any GitHub hosts.\n' })

    const status = await runPreflightCheck()

    expect(status.gh).toEqual({ installed: true, authenticated: false })
  })

  it('keeps older gh stderr success output from showing a false auth warning', async () => {
    execFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'git version 2.0.0\n' })
      .mockResolvedValueOnce({ stdout: 'gh version 2.0.0\n' })
      .mockRejectedValueOnce({ stderr: 'Logged in to github.com account octocat\n' })

    const status = await runPreflightCheck()

    expect(status.gh).toEqual({ installed: true, authenticated: true })
  })

  it('re-runs the probe when forced so updated gh auth state is visible without relaunch', async () => {
    execFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'git version 2.0.0\n' })
      .mockResolvedValueOnce({ stdout: 'gh version 2.0.0\n' })
      .mockRejectedValueOnce({ stderr: 'You are not logged into any GitHub hosts.\n' })
      .mockResolvedValueOnce({ stdout: 'git version 2.0.0\n' })
      .mockResolvedValueOnce({ stdout: 'gh version 2.0.0\n' })
      .mockResolvedValueOnce({ stdout: 'github.com\n  - Active account: true\n' })

    const firstStatus = await runPreflightCheck()
    const refreshedStatus = await runPreflightCheck(true)

    expect(firstStatus.gh).toEqual({ installed: true, authenticated: false })
    expect(refreshedStatus.gh).toEqual({ installed: true, authenticated: true })
    expect(execFileAsyncMock).toHaveBeenCalledTimes(6)
  })

  it('registers the preflight handler', async () => {
    execFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'git version 2.0.0\n' })
      .mockResolvedValueOnce({ stdout: 'gh version 2.0.0\n' })
      .mockResolvedValueOnce({ stdout: 'github.com\n' })

    registerPreflightHandlers()

    const status = await handlers['preflight:check']()

    expect(status).toEqual({
      git: { installed: true },
      gh: { installed: true, authenticated: true }
    })
  })

  it('lets the IPC handler bypass the session cache when forced', async () => {
    execFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'git version 2.0.0\n' })
      .mockResolvedValueOnce({ stdout: 'gh version 2.0.0\n' })
      .mockRejectedValueOnce({ stderr: 'You are not logged into any GitHub hosts.\n' })
      .mockResolvedValueOnce({ stdout: 'git version 2.0.0\n' })
      .mockResolvedValueOnce({ stdout: 'gh version 2.0.0\n' })
      .mockResolvedValueOnce({ stdout: 'github.com\n  - Active account: true\n' })

    registerPreflightHandlers()

    const firstStatus = await handlers['preflight:check']()
    const refreshedStatus = await handlers['preflight:check'](null, { force: true })

    expect(firstStatus).toEqual({
      git: { installed: true },
      gh: { installed: true, authenticated: false }
    })
    expect(refreshedStatus).toEqual({
      git: { installed: true },
      gh: { installed: true, authenticated: true }
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
      if (String(args[0]) === 'cursor-agent') {
        return { stdout: '/Users/test/.local/bin/cursor-agent\n' }
      }
      throw new Error('not found')
    })

    registerPreflightHandlers()

    await expect(handlers['preflight:detectAgents']()).resolves.toEqual(['cursor'])
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
