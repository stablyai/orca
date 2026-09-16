import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  handleMock,
  execFileMock,
  execFileAsyncMock,
  runWslProcessMock,
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
  runWslProcessMock: vi.fn(),
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

// WSL commands now route through the runner, not execFile('wsl.exe', ...).
vi.mock('../wsl/wsl-runner', () => ({ runWslProcess: runWslProcessMock }))

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

import { _resetPreflightCache, registerPreflightHandlers, runPreflightCheck } from './preflight'
import {
  defaultAzureDevOpsStatus,
  defaultBitbucketStatus,
  defaultGiteaStatus,
  resetPreflightMocks,
  type HandlerMap
} from './preflight-test-harness'

describe('preflight', () => {
  const originalPlatform = process.platform
  const handlers: HandlerMap = {}

  beforeEach(() => {
    resetPreflightMocks(
      {
        handleMock,
        execFileAsyncMock,
        runWslProcessMock,
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
      timeout: 5000,
      windowsHide: true
    })
    expect(execFileAsyncMock).toHaveBeenNthCalledWith(5, 'glab', ['auth', 'status'], {
      encoding: 'utf-8',
      timeout: 5000,
      windowsHide: true
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
    execFileAsyncMock.mockImplementation(async (command) => {
      if (command === 'git') {
        return { stdout: 'git version 2.0.0\n' }
      }
      if (command === 'gh') {
        throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' })
      }
      if (command === 'glab') {
        throw Object.assign(new Error('spawn glab ENOENT'), { code: 'ENOENT' })
      }
      throw new Error(`unexpected command ${String(command)}`)
    })
    runWslProcessMock.mockImplementation(async ({ script }: { script: string }) => {
      if (script.includes('gh') && script.includes('--version')) {
        return {
          environmentResolved: true,
          code: 0,
          stdout: 'gh version 2.0.0\n',
          stderr: '',
          timedOut: false
        }
      }
      if (script.includes('gh') && script.includes('auth status')) {
        return {
          environmentResolved: true,
          code: 0,
          stdout: 'github.com\n  - Active account: true\n',
          stderr: '',
          timedOut: false
        }
      }
      throw new Error(`unexpected WSL script ${script}`)
    })

    const status = await runPreflightCheck(false, { wslDistro: 'Ubuntu' })

    expect(status.gh).toEqual({ installed: true, authenticated: true })
    expect(runWslProcessMock).toHaveBeenCalledWith(
      expect.objectContaining({
        distro: 'Ubuntu',
        loginPath: 'preferred',
        script: expect.stringMatching(/gh[\s\S]*--version/)
      })
    )
    expect(runWslProcessMock).toHaveBeenCalledWith(
      expect.objectContaining({
        distro: 'Ubuntu',
        loginPath: 'preferred',
        script: expect.stringMatching(/gh[\s\S]*auth status/)
      })
    )
  })

  describe('WSL preflight caching', () => {
    // Why win32 + these stubs: a WSL target probes git/gh/glab through the
    // runner, so every case below counts runner spawns rather than execFile.
    function stubWslProbes(): void {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      execFileAsyncMock.mockImplementation(async () => {
        throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })
      })
      runWslProcessMock.mockImplementation(async ({ script }: { script: string }) => ({
        environmentResolved: true,
        code: 0,
        stdout: script.includes('auth status')
          ? 'github.com\n  - Active account: true\n'
          : 'version 2.0.0\n',
        stderr: '',
        timedOut: false
      }))
    }

    it('reuses the cached result instead of re-spawning wsl.exe probes', async () => {
      stubWslProbes()

      const first = await runPreflightCheck(false, { wslDistro: 'Ubuntu' })
      const spawnsAfterFirst = runWslProcessMock.mock.calls.length
      const second = await runPreflightCheck(false, { wslDistro: 'Ubuntu' })

      expect(spawnsAfterFirst).toBeGreaterThan(0)
      expect(runWslProcessMock.mock.calls.length).toBe(spawnsAfterFirst)
      expect(second).toEqual(first)
    })

    it('keeps each distro on its own cache entry', async () => {
      stubWslProbes()

      await runPreflightCheck(false, { wslDistro: 'Ubuntu' })
      const spawnsAfterUbuntu = runWslProcessMock.mock.calls.length
      await runPreflightCheck(false, { wslDistro: 'Debian' })

      expect(runWslProcessMock.mock.calls.length).toBeGreaterThan(spawnsAfterUbuntu)
      expect(runWslProcessMock).toHaveBeenCalledWith(expect.objectContaining({ distro: 'Debian' }))
    })

    it('re-probes when the caller forces a refresh', async () => {
      stubWslProbes()

      await runPreflightCheck(false, { wslDistro: 'Ubuntu' })
      const spawnsAfterFirst = runWslProcessMock.mock.calls.length
      await runPreflightCheck(true, { wslDistro: 'Ubuntu' })

      expect(runWslProcessMock.mock.calls.length).toBeGreaterThan(spawnsAfterFirst)
    })

    it('collapses concurrent callers onto one probe set', async () => {
      stubWslProbes()

      const [first, second] = await Promise.all([
        runPreflightCheck(false, { wslDistro: 'Ubuntu' }),
        runPreflightCheck(false, { wslDistro: 'Ubuntu' })
      ])
      const singleRunSpawns = runWslProcessMock.mock.calls.length

      runWslProcessMock.mockClear()
      await runPreflightCheck(true, { wslDistro: 'Ubuntu' })

      expect(first).toEqual(second)
      // One shared run, not two: a second full set would double the spawn count.
      expect(singleRunSpawns).toBe(runWslProcessMock.mock.calls.length)
    })

    // Why this matters: an unreachable distro reports the same `installed:
    // false` as a distro with no tooling, so a session-lifetime cache would pin
    // "git not installed" until relaunch. The TTL must let it recover.
    // Why these two: a slower run settling last must not overwrite a newer
    // answer, or a forced refresh silently returns to the status it replaced.
    it('does not let a superseded probe overwrite a newer forced refresh', async () => {
      stubWslProbes()
      // Why gate on phase captured at call time: the stale run's three
      // --version probes all start before the refresh, and all report nothing
      // installed, so it never issues auth calls. The two runs are then
      // trivially distinguishable in the cached result.
      let phase: 'stale' | 'fresh' = 'stale'
      let releaseStale!: () => void
      const staleGate = new Promise<void>((resolve) => {
        releaseStale = resolve
      })
      runWslProcessMock.mockImplementation(async ({ script }: { script: string }) => {
        const isStale = phase === 'stale'
        if (isStale) {
          await staleGate
        }
        return {
          environmentResolved: true,
          code: isStale ? 1 : 0,
          stdout: isStale
            ? ''
            : script.includes('auth status')
              ? 'github.com\n  - Active account: true\n'
              : 'version 2.0.0\n',
          stderr: '',
          timedOut: false
        }
      })

      const stalePending = runPreflightCheck(false, { wslDistro: 'Ubuntu' })
      phase = 'fresh'
      const fresh = await runPreflightCheck(true, { wslDistro: 'Ubuntu' })
      expect(fresh.git).toEqual({ installed: true })

      releaseStale()
      const staleResult = await stalePending
      expect(staleResult.git).toEqual({ installed: false })

      // The superseded run still returns its own answer to its own caller, but
      // must not have become the cached one.
      const cachedNow = await runPreflightCheck(false, { wslDistro: 'Ubuntu' })
      expect(cachedNow.git).toEqual({ installed: true })
    })

    it('does not repopulate a cache that was reset while a probe was in flight', async () => {
      stubWslProbes()
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      runWslProcessMock.mockImplementation(async ({ script }: { script: string }) => {
        await gate
        return {
          environmentResolved: true,
          code: 0,
          stdout: script.includes('auth status')
            ? 'github.com\n  - Active account: true\n'
            : 'version 2.0.0\n',
          stderr: '',
          timedOut: false
        }
      })

      const inFlight = runPreflightCheck(false, { wslDistro: 'Ubuntu' })
      _resetPreflightCache()
      release()
      await inFlight

      runWslProcessMock.mockClear()
      await runPreflightCheck(false, { wslDistro: 'Ubuntu' })
      expect(runWslProcessMock.mock.calls.length).toBeGreaterThan(0)
    })

    it('re-probes after the cache entry expires so a transient failure self-heals', async () => {
      vi.useFakeTimers()
      try {
        stubWslProbes()
        runWslProcessMock.mockRejectedValue(new Error('distro not running'))

        const failed = await runPreflightCheck(false, { wslDistro: 'Ubuntu' })
        expect(failed.git).toEqual({ installed: false })

        stubWslProbes()
        runWslProcessMock.mockClear()
        vi.advanceTimersByTime(30_000 + 1)
        const recovered = await runPreflightCheck(false, { wslDistro: 'Ubuntu' })

        expect(runWslProcessMock.mock.calls.length).toBeGreaterThan(0)
        expect(recovered.git).toEqual({ installed: true })
      } finally {
        vi.useRealTimers()
      }
    })
  })

  it('uses the persisted Windows Path when probing host CLIs', async () => {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })
    mergePersistedWindowsPathMock.mockImplementation((env: Record<string, string>) => {
      env.Path = 'C:\\Windows\\System32;C:\\Program Files\\GitHub CLI'
    })
    execFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'git version 2.0.0\n' })
      .mockResolvedValueOnce({ stdout: 'gh version 2.0.0\n' })
      .mockResolvedValueOnce({ stdout: 'glab version 1.92.1\n' })
      .mockResolvedValueOnce({ stdout: 'github.com\n  - Active account: true\n' })
      .mockResolvedValueOnce({ stdout: 'Logged in to gitlab.com\n' })

    const status = await runPreflightCheck()

    expect(status.gh).toEqual({ installed: true, authenticated: true })
    expect(mergePersistedWindowsPathMock).toHaveBeenCalled()
    expect(execFileAsyncMock).toHaveBeenNthCalledWith(2, 'gh', ['--version'], {
      encoding: 'utf-8',
      timeout: 5000,
      windowsHide: true,
      env: expect.objectContaining({
        Path: 'C:\\Windows\\System32;C:\\Program Files\\GitHub CLI'
      })
    })
  })

  it('times out hung WSL preflight probes', async () => {
    vi.useFakeTimers()
    try {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: 'win32'
      })
      execFileAsyncMock.mockImplementation((command) => {
        if (command === 'git') {
          return Promise.resolve({ stdout: 'git version 2.0.0\n' })
        }
        if (command === 'gh' || command === 'glab') {
          return Promise.reject(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))
        }
        throw new Error(`unexpected command ${String(command)}`)
      })
      runWslProcessMock.mockImplementation(({ script }: { script: string }) => {
        if (script.includes("'gh' --version")) {
          return new Promise(() => {})
        }
        if (script.includes("'glab' --version")) {
          return Promise.reject(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))
        }
        throw new Error(`unexpected WSL script ${script}`)
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

  it('awaits the persisted Windows Path refresh before a forced host CLI preflight', async () => {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })
    let finishRefresh!: () => void
    mergePersistedWindowsPathAsyncMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishRefresh = resolve
        })
    )
    execFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'git version 2.0.0\n' })
      .mockResolvedValueOnce({ stdout: 'gh version 2.0.0\n' })
      .mockResolvedValueOnce({ stdout: 'glab version 1.92.1\n' })
      .mockResolvedValueOnce({ stdout: 'github.com\n  - Active account: true\n' })
      .mockResolvedValueOnce({ stdout: 'Logged in to gitlab.com\n' })

    const check = runPreflightCheck(true)
    await Promise.resolve()

    expect(execFileAsyncMock).not.toHaveBeenCalled()
    finishRefresh()
    await expect(check).resolves.toMatchObject({
      gh: { installed: true, authenticated: true }
    })

    expect(mergePersistedWindowsPathAsyncMock).toHaveBeenNthCalledWith(1, process.env, {
      forceRefresh: true
    })
  })

  it('does not refresh host Windows Path for forced WSL preflight', async () => {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })
    execFileAsyncMock.mockImplementation(async (command) => {
      throw new Error(`unexpected command ${String(command)}`)
    })
    runWslProcessMock.mockImplementation(async ({ script }: { script: string }) => {
      const ok = (stdout: string) => ({
        environmentResolved: true,
        code: 0,
        stdout,
        stderr: '',
        timedOut: false
      })
      if (script.includes('git') && script.includes('--version')) {
        return ok('git version 2.0.0\n')
      }
      if (script.includes('gh') && script.includes('--version')) {
        return ok('gh version 2.0.0\n')
      }
      if (script.includes('glab') && script.includes('--version')) {
        return ok('glab version 1.92.1\n')
      }
      if (script.includes('gh') && script.includes('auth status')) {
        return ok('github.com\n  - Active account: true\n')
      }
      if (script.includes('glab') && script.includes('auth status')) {
        return ok('Logged in to gitlab.com\n')
      }
      throw new Error(`unexpected WSL script ${script}`)
    })

    await expect(runPreflightCheck(true, { wslDistro: 'Ubuntu' })).resolves.toMatchObject({
      gh: { installed: true, authenticated: true }
    })

    expect(mergePersistedWindowsPathAsyncMock).not.toHaveBeenCalled()
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

  it('lets a resolved host project runtime override stale WSL context flags', async () => {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })
    execFileAsyncMock.mockImplementation(async (command, args) => {
      expect(command).not.toBe('wsl.exe')
      if (command === 'git' || command === 'gh' || command === 'glab') {
        return { stdout: `${String(command)} ok\n` }
      }
      throw new Error(`unexpected command ${String(command)} ${JSON.stringify(args)}`)
    })

    const status = await runPreflightCheck(false, {
      wslDistro: 'Ubuntu',
      projectRuntime: {
        status: 'resolved',
        runtime: {
          kind: 'windows-host',
          hostPlatform: 'win32',
          projectId: 'project-1',
          reason: 'project-override',
          cacheKey: 'project-1:windows-host'
        }
      }
    })

    expect(status.git.installed).toBe(true)
    expect(mergePersistedWindowsPathMock).toHaveBeenCalled()
  })
})
