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
  getGiteaAuthStatusMock,
  resolveCliCommandsMock,
  isCommandOnLocalPathMock,
  mergePersistedWindowsPathAsyncMock,
  mergePersistedWindowsPathMock
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  execFileMock: vi.fn(),
  execFileAsyncMock: vi.fn(),
  hydrateShellPathMock: vi.fn(),
  mergePathSegmentsMock: vi.fn(),
  getActiveMultiplexerMock: vi.fn(),
  getBitbucketAuthStatusMock: vi.fn(),
  getAzureDevOpsAuthStatusMock: vi.fn(),
  getGiteaAuthStatusMock: vi.fn(),
  resolveCliCommandsMock: vi.fn(),
  isCommandOnLocalPathMock: vi.fn(),
  mergePersistedWindowsPathAsyncMock: vi.fn(),
  mergePersistedWindowsPathMock: vi.fn()
}))

const runWslProcessMock = vi.hoisted(() => vi.fn())
// Why the runner and not child_process: WSL agent detection goes through
// runWslProcess now, so a child_process mock never sees it.
vi.mock('../wsl/wsl-runner', () => ({ runWslProcess: runWslProcessMock }))

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

vi.mock('../../shared/node-cli-command-resolution', () => ({
  resolveCliCommands: resolveCliCommandsMock
}))

// Why (#9297): local PATH resolution is now fs-based (no where/which spawn).
// These tests express "which commands are on PATH" via the where/which mock,
// so route the resolver through that same mock to preserve their intent.
vi.mock('./command-path-resolver', () => ({
  isCommandOnLocalPath: isCommandOnLocalPathMock
}))

vi.mock('../pty/windows-environment-path', () => ({
  mergePersistedWindowsPathAsync: mergePersistedWindowsPathAsyncMock,
  mergePersistedWindowsPath: mergePersistedWindowsPathMock
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

import { registerPreflightHandlers } from './preflight'
import { resetPreflightMocks, type HandlerMap } from './preflight-test-harness'

describe('preflight', () => {
  const originalPlatform = process.platform
  const handlers: HandlerMap = {}

  beforeEach(() => {
    runWslProcessMock.mockReset()
    resetPreflightMocks(
      {
        handleMock,
        execFileAsyncMock,
        hydrateShellPathMock,
        mergePathSegmentsMock,
        getActiveMultiplexerMock,
        getBitbucketAuthStatusMock,
        getAzureDevOpsAuthStatusMock,
        getGiteaAuthStatusMock,
        resolveCliCommandsMock,
        isCommandOnLocalPathMock,
        mergePersistedWindowsPathAsyncMock,
        mergePersistedWindowsPathMock
      },
      handlers
    )
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: originalPlatform
    })
  })

  it('does not hydrate the host PATH when refreshing agents for a resolved WSL runtime', async () => {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })
    runWslProcessMock.mockImplementation(async ({ script }: { script: string }) => {
      if (script.includes("'claude'")) {
        return {
          environmentResolved: true,
          code: 0,
          stdout: '__ORCA_AGENT_PATH__claude\t/home/test/.local/bin/claude\n',
          stderr: '',
          timedOut: false
        }
      }
      throw new Error('not found')
    })

    registerPreflightHandlers()

    const result = (await handlers['preflight:refreshAgents'](undefined, {
      projectRuntime: {
        status: 'resolved',
        runtime: {
          kind: 'wsl',
          hostPlatform: 'wsl',
          projectId: 'project-1',
          distro: 'Ubuntu',
          reason: 'project-override',
          cacheKey: 'project-1:wsl:Ubuntu'
        }
      }
    })) as {
      agents: string[]
      addedPathSegments: string[]
      shellHydrationOk: boolean
      pathSource: string
      pathFailureReason: string
    }

    expect(result).toEqual({
      agents: ['claude'],
      addedPathSegments: [],
      shellHydrationOk: true,
      pathSource: 'sync_seed_only',
      pathFailureReason: 'none'
    })
    expect(hydrateShellPathMock).not.toHaveBeenCalled()
    expect(mergePathSegmentsMock).not.toHaveBeenCalled()
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
        return {
          environmentResolved: true,
          code: 0,
          stdout: '/Users/test/.opencode/bin/opencode\n',
          stderr: '',
          timedOut: false
        }
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
        return {
          environmentResolved: true,
          code: 0,
          stdout: '/Users/test/.local/bin/claude\n',
          stderr: '',
          timedOut: false
        }
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
