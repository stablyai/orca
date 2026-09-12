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
vi.mock('../ssh/ssh-target-registry', () => ({
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

import { detectRemoteForgeClis, registerPreflightHandlers, runPreflightCheck } from './preflight'
import { resetPreflightMocks, type HandlerMap } from './preflight-test-harness'
import type { PreflightRuntimeContext } from '../../preload/api/preflight-api'

describe('preflight', () => {
  const originalPlatform = process.platform
  const handlers: HandlerMap = {}

  beforeEach(() => {
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

  it('sends aliased detection commands through the SSH remote preflight path', async () => {
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
      commands: expect.arrayContaining([
        { id: 'openclaude', cmd: 'openclaude' },
        { id: 'mistral-vibe', cmd: 'vibe' },
        { id: 'mistral-vibe', cmd: 'mistral-vibe' }
      ])
    })
  })

  it('returns no remote agents when the SSH connection is unavailable', async () => {
    getActiveMultiplexerMock.mockReturnValue(null)

    registerPreflightHandlers()

    await expect(
      handlers['preflight:detectRemoteAgents'](undefined, { connectionId: 'ssh-1' })
    ).resolves.toEqual([])
  })

  it('returns no remote agents when the SSH connection is disposed', async () => {
    const request = vi.fn()
    getActiveMultiplexerMock.mockReturnValue({
      isDisposed: () => true,
      request
    })

    registerPreflightHandlers()

    await expect(
      handlers['preflight:detectRemoteAgents'](undefined, { connectionId: 'ssh-1' })
    ).resolves.toEqual([])
    expect(request).not.toHaveBeenCalled()
  })

  it('sends remote Windows shell capability probes through the SSH preflight path', async () => {
    const request = vi.fn().mockResolvedValue({
      wslAvailable: true,
      wslDistros: ['Ubuntu'],
      pwshAvailable: true,
      gitBashAvailable: true,
      hostPlatform: 'win32'
    })
    getActiveMultiplexerMock.mockReturnValue({
      isDisposed: () => false,
      request
    })

    registerPreflightHandlers()

    await expect(
      handlers['preflight:detectRemoteWindowsTerminalCapabilities'](undefined, {
        connectionId: 'ssh-1'
      })
    ).resolves.toEqual({
      wslAvailable: true,
      wslDistros: ['Ubuntu'],
      pwshAvailable: true,
      gitBashAvailable: true,
      hostPlatform: 'win32'
    })
    expect(request).toHaveBeenCalledWith('preflight.detectWindowsTerminalCapabilities', {})
  })

  function contextWithSshHost(connectionId: string, hostLabel: string): PreflightRuntimeContext {
    return { sshHost: { connectionId, hostLabel } }
  }

  // Why: the standard local-probe sequence (git/gh/glab install checks, then
  // gh/glab auth status) so hostForge cases don't also assert on unrelated
  // local install/auth outcomes.
  function mockAuthenticatedLocalProbes(): void {
    execFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'git version 2.0.0\n' })
      .mockResolvedValueOnce({ stdout: 'gh version 2.0.0\n' })
      .mockResolvedValueOnce({ stdout: 'glab version 1.92.1\n' })
      .mockResolvedValueOnce({ stdout: 'github.com\n  - Active account: true\n' })
      .mockResolvedValueOnce({ stdout: 'Logged in to gitlab.com\n' })
  }

  describe('detectRemoteForgeClis', () => {
    it('requests the relay method with both forge CLIs under a bounded timeout', async () => {
      const request = vi
        .fn()
        .mockResolvedValue({ results: { glab: { installed: true, authenticated: true } } })
      getActiveMultiplexerMock.mockReturnValue({ isDisposed: () => false, request })

      const results = await detectRemoteForgeClis({ connectionId: 'ssh-1' })

      expect(request).toHaveBeenCalledWith(
        'preflight.detectForgeClis',
        { clis: ['gh', 'glab'] },
        { timeoutMs: 8000 }
      )
      expect(results?.glab).toEqual({ installed: true, authenticated: true })
    })

    it('returns null for a malformed relay response', async () => {
      const request = vi.fn().mockResolvedValue({})
      getActiveMultiplexerMock.mockReturnValue({ isDisposed: () => false, request })

      expect(await detectRemoteForgeClis({ connectionId: 'ssh-1' })).toBeNull()
    })

    it('returns null when no live mux exists', async () => {
      getActiveMultiplexerMock.mockReturnValue(undefined)

      expect(await detectRemoteForgeClis({ connectionId: 'ssh-1' })).toBeNull()
    })

    it('returns null when the multiplexer is disposed', async () => {
      const request = vi.fn()
      getActiveMultiplexerMock.mockReturnValue({ isDisposed: () => true, request })

      expect(await detectRemoteForgeClis({ connectionId: 'ssh-1' })).toBeNull()
      expect(request).not.toHaveBeenCalled()
    })

    it('returns null on method-not-found from an old relay', async () => {
      const request = vi.fn().mockRejectedValue({ code: -32601 })
      getActiveMultiplexerMock.mockReturnValue({ isDisposed: () => false, request })

      expect(await detectRemoteForgeClis({ connectionId: 'ssh-1' })).toBeNull()
    })
  })

  describe('runPreflightCheck hostForge', () => {
    it('attaches hostForge when the context names an SSH execution host', async () => {
      mockAuthenticatedLocalProbes()
      const request = vi
        .fn()
        .mockResolvedValue({ results: { glab: { installed: true, authenticated: true } } })
      getActiveMultiplexerMock.mockReturnValue({ isDisposed: () => false, request })

      const status = await runPreflightCheck(true, contextWithSshHost('ssh-1', 'work-box'))

      expect(status.hostForge?.connectionId).toBe('ssh-1')
      expect(status.hostForge?.hostLabel).toBe('work-box')
      expect(status.hostForge?.glab).toEqual({ installed: true, authenticated: true })
      expect(request).toHaveBeenCalledWith(
        'preflight.detectForgeClis',
        { clis: ['gh', 'glab'] },
        { timeoutMs: 8000 }
      )
    })

    it('omits hostForge when the host knows neither forge CLI', async () => {
      mockAuthenticatedLocalProbes()
      const request = vi.fn().mockResolvedValue({ results: {} })
      getActiveMultiplexerMock.mockReturnValue({ isDisposed: () => false, request })

      const status = await runPreflightCheck(true, contextWithSshHost('ssh-1', 'work-box'))

      expect(status.hostForge).toBeUndefined()
    })

    it('keeps an SSH-host result out of the local cache slot', async () => {
      mockAuthenticatedLocalProbes()
      const request = vi
        .fn()
        .mockResolvedValue({ results: { glab: { installed: true, authenticated: true } } })
      getActiveMultiplexerMock.mockReturnValue({ isDisposed: () => false, request })

      await runPreflightCheck(true, contextWithSshHost('ssh-1', 'work-box'))
      getActiveMultiplexerMock.mockClear()
      mockAuthenticatedLocalProbes()
      const local = await runPreflightCheck(false)

      expect(local.hostForge).toBeUndefined()
      expect(getActiveMultiplexerMock).not.toHaveBeenCalled()
    })

    it('omits hostForge entirely for local contexts', async () => {
      mockAuthenticatedLocalProbes()

      const status = await runPreflightCheck(true)

      expect(status.hostForge).toBeUndefined()
      expect(getActiveMultiplexerMock).not.toHaveBeenCalled()
    })

    it('omits hostForge when the remote probe returns null, leaving local status intact', async () => {
      mockAuthenticatedLocalProbes()
      getActiveMultiplexerMock.mockReturnValue(undefined)

      const status = await runPreflightCheck(true, contextWithSshHost('ssh-1', 'work-box'))

      expect(status.hostForge).toBeUndefined()
      expect(status.glab).toEqual({ installed: true, authenticated: true })
    })
  })
})
