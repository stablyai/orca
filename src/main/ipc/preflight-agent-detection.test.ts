import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as LocalCommandResolver from './command-path-resolver'

const {
  handleMock,
  execFileMock,
  execFileAsyncMock,
  hydrateShellPathMock,
  mergePathSegmentsMock,
  getBitbucketAuthStatusMock,
  getAzureDevOpsAuthStatusMock,
  getGiteaAuthStatusMock,
  resolveCliCommandsMock,
  findCommandsOnLocalPathMock,
  isCommandOnLocalPathMock,
  listLocalCommandPathsMock,
  mergePersistedWindowsPathAsyncMock,
  mergePersistedWindowsPathMock
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  execFileMock: vi.fn(),
  execFileAsyncMock: vi.fn(),
  hydrateShellPathMock: vi.fn(),
  mergePathSegmentsMock: vi.fn(),
  getBitbucketAuthStatusMock: vi.fn(),
  getAzureDevOpsAuthStatusMock: vi.fn(),
  getGiteaAuthStatusMock: vi.fn(),
  resolveCliCommandsMock: vi.fn(),
  findCommandsOnLocalPathMock: vi.fn(),
  isCommandOnLocalPathMock: vi.fn(),
  listLocalCommandPathsMock: vi.fn(),
  mergePersistedWindowsPathAsyncMock: vi.fn(),
  mergePersistedWindowsPathMock: vi.fn()
}))

const runWslProcessMock = vi.hoisted(() => vi.fn())
// These cases cover a running distro; the E9 stopped-distro gate has its own suite.
vi.mock('../wsl/wsl-background-exec-gate', () => ({
  assertWslDistroRunningForExec: async () => {},
  runAsWslExecUserAct: async (_distro: unknown, act: () => Promise<unknown>) => act()
}))

// WSL detection uses runWslProcess, so child_process mocks cannot observe it.
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

vi.mock('../runtime/structured-agent-shell-environment', () => ({
  captureHostShellEnvironment: vi.fn(async (beforeCapture?: () => Promise<unknown>) =>
    beforeCapture?.()
  )
}))

vi.mock('../startup/hydrate-shell-path', () => ({
  hydrateShellPath: hydrateShellPathMock,
  mergePathSegments: mergePathSegmentsMock
}))

vi.mock('../../shared/node-cli-command-resolution', () => ({
  resolveCliCommands: resolveCliCommandsMock
}))

// Route filesystem PATH resolution through the existing command-lookup mock.
vi.mock('./command-path-resolver', async (importOriginal) => ({
  ...(await importOriginal<typeof LocalCommandResolver>()),
  findCommandsOnLocalPath: findCommandsOnLocalPathMock,
  isCommandOnLocalPath: isCommandOnLocalPathMock,
  listLocalCommandPaths: listLocalCommandPathsMock
}))

vi.mock('../pty/windows-environment-path', () => ({
  mergePersistedWindowsPathAsync: mergePersistedWindowsPathAsyncMock,
  mergePersistedWindowsPath: mergePersistedWindowsPathMock
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

import { detectInstalledAgents } from '../preflight/agent-detection'
import { registerPreflightHandlers } from './preflight'
import { createGlobalSettingsFixture } from '../../shared/global-settings-test-fixture'
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
        getBitbucketAuthStatusMock,
        getAzureDevOpsAuthStatusMock,
        getGiteaAuthStatusMock,
        resolveCliCommandsMock,
        findCommandsOnLocalPathMock,
        isCommandOnLocalPathMock,
        listLocalCommandPathsMock,
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

  it.each(['win32', 'darwin', 'linux'])(
    'skips disabled probes on automatic %s detection and refresh while Settings stays complete',
    async (platform) => {
      Object.defineProperty(process, 'platform', { value: platform })
      const settings = createGlobalSettingsFixture({ disabledTuiAgents: ['kiro'] })
      registerPreflightHandlers({ getSettings: () => settings })
      isCommandOnLocalPathMock.mockImplementation(async (command: string) =>
        ['claude', 'kiro-cli'].includes(command)
      )
      await expect(
        handlers['preflight:detectAgents'](undefined, {
          enabledOnly: true,
          disabledTuiAgents: []
        })
      ).resolves.toEqual(['claude'])
      expect(isCommandOnLocalPathMock.mock.calls.map(([command]) => command)).not.toContain(
        'kiro-cli'
      )
      expect(resolveCliCommandsMock).toHaveBeenCalledWith(
        expect.not.arrayContaining(['kiro-cli']),
        { skipPathSearch: true }
      )

      isCommandOnLocalPathMock.mockClear()
      await expect(
        handlers['preflight:refreshAgents'](undefined, { enabledOnly: true })
      ).resolves.toMatchObject({ agents: ['claude'] })
      expect(isCommandOnLocalPathMock.mock.calls.map(([command]) => command)).not.toContain(
        'kiro-cli'
      )

      await expect(handlers['preflight:detectAgents']()).resolves.toEqual(['claude', 'kiro'])
      expect(isCommandOnLocalPathMock.mock.calls.map(([command]) => command)).toContain('kiro-cli')
      await expect(handlers['preflight:refreshAgents']()).resolves.toMatchObject({
        agents: ['claude', 'kiro']
      })

      settings.disabledTuiAgents = []
      await expect(
        handlers['preflight:detectAgents'](undefined, { enabledOnly: true })
      ).resolves.toEqual(['claude', 'kiro'])
    }
  )

  it('filters the WSL guest command batch for automatic inventory and keeps explicit inventory complete', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const settings = createGlobalSettingsFixture({ disabledTuiAgents: ['kiro'] })
    registerPreflightHandlers({ getSettings: () => settings })
    runWslProcessMock.mockResolvedValue({
      code: 0,
      timedOut: false,
      stdout:
        '__ORCA_AGENT_PATH__claude\t/home/me/bin/claude\n__ORCA_AGENT_PATH__kiro-cli\t/home/me/bin/kiro-cli\n',
      stderr: ''
    })
    await expect(
      handlers['preflight:detectAgents'](undefined, { wslDistro: 'Ubuntu', enabledOnly: true })
    ).resolves.toEqual(['claude'])
    expect(runWslProcessMock.mock.lastCall?.[0]).toMatchObject({ distro: 'Ubuntu' })
    expect(runWslProcessMock.mock.lastCall?.[0].script).not.toContain("'kiro-cli'")
    await expect(
      handlers['preflight:detectAgents'](undefined, { wslDistro: 'Ubuntu' })
    ).resolves.toEqual(['claude', 'kiro'])
    expect(runWslProcessMock.mock.lastCall?.[0].script).toContain("'kiro-cli'")
    expect(isCommandOnLocalPathMock).not.toHaveBeenCalled()
  })

  it('detects agents via the install-dir resolver when which fails (stripped GUI PATH)', async () => {
    // Cold GUI detection can precede shell-PATH hydration; install directories remain a fallback.
    execFileAsyncMock.mockImplementation(async (command) => {
      if (command !== 'which') {
        throw new Error(`unexpected command ${String(command)}`)
      }
      throw new Error('not found')
    })
    resolveCliCommandsMock.mockImplementation(
      (commands: string[]) =>
        new Map(
          commands.map((cmd) => {
            if (cmd === 'claude') {
              return [cmd, '/Users/test/.local/bin/claude']
            }
            if (cmd === 'codex') {
              return [cmd, '/Users/test/.asdf/shims/codex']
            }
            if (cmd === 'opencode') {
              return [cmd, '/Users/test/Library/pnpm/opencode']
            }
            return [cmd, cmd]
          })
        )
    )

    await expect(detectInstalledAgents()).resolves.toEqual(['claude', 'codex', 'opencode'])
    expect(resolveCliCommandsMock).toHaveBeenCalledTimes(1)
  })

  it('treats an agent as not installed when the install-dir resolver throws', async () => {
    execFileAsyncMock.mockImplementation(async (command) => {
      if (command !== 'which') {
        throw new Error(`unexpected command ${String(command)}`)
      }
      throw new Error('not found')
    })
    resolveCliCommandsMock.mockImplementation(() => {
      throw new Error('EACCES: permission denied')
    })

    await expect(detectInstalledAgents()).resolves.toEqual([])
  })

  it('detects agents from the selected WSL distro for a WSL workspace', async () => {
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

    await expect(detectInstalledAgents({ wslDistro: 'Ubuntu' })).resolves.toEqual(['claude'])
    expect(runWslProcessMock).toHaveBeenCalledTimes(1)
    // Local install-directory fallback must never supply WSL results.
    expect(resolveCliCommandsMock).not.toHaveBeenCalled()
    // The runner owns argv; this suite checks distro and PATH lane.
    expect(runWslProcessMock).toHaveBeenCalledWith(
      expect.objectContaining({ distro: 'Ubuntu', loginPath: 'preferred' })
    )
  })

  it('detects agents from the default WSL distro when requested', async () => {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })
    runWslProcessMock.mockImplementation(async ({ script }: { script: string }) => {
      if (script.includes("'codex'")) {
        return {
          environmentResolved: true,
          code: 0,
          stdout: '__ORCA_AGENT_PATH__codex\t/home/test/.local/bin/codex\n',
          stderr: '',
          timedOut: false
        }
      }
      throw new Error('not found')
    })

    await expect(detectInstalledAgents({ wslDefault: true })).resolves.toEqual(['codex'])
    expect(runWslProcessMock).toHaveBeenCalledTimes(1)
    expect(resolveCliCommandsMock).not.toHaveBeenCalled()
    expect(runWslProcessMock).toHaveBeenCalledWith(
      expect.objectContaining({ distro: undefined, loginPath: 'preferred' })
    )
  })
})
