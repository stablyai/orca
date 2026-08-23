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

import { registerPreflightHandlers } from './preflight'
import { resetPreflightMocks, type HandlerMap } from './preflight-test-harness'

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
})
