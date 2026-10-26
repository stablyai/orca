/* PATH detection must use filesystem lookup: per-agent where/which spawns can each be stalled by privilege-management software (#9297). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  handleMock,
  execFileMock,
  execFileAsyncMock,
  hydrateShellPathMock,
  mergePathSegmentsMock,
  getBitbucketAuthStatusMock,
  getAzureDevOpsAuthStatusMock,
  getGiteaAuthStatusMock,
  detectCommandsInInstallDirsMock,
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
  detectCommandsInInstallDirsMock: vi.fn(),
  mergePersistedWindowsPathAsyncMock: vi.fn(),
  mergePersistedWindowsPathMock: vi.fn()
}))

vi.mock('electron', () => ({ ipcMain: { handle: handleMock } }))

vi.mock('child_process', () => {
  const execFileWithPromisify = Object.assign(execFileMock, {
    [Symbol.for('nodejs.util.promisify.custom')]: execFileAsyncMock
  })
  return { execFile: execFileWithPromisify, spawn: vi.fn() }
})

vi.mock('../startup/hydrate-shell-path', () => ({
  hydrateShellPath: hydrateShellPathMock,
  mergePathSegments: mergePathSegmentsMock
}))

vi.mock('../bitbucket/client', () => ({ getBitbucketAuthStatus: getBitbucketAuthStatusMock }))
vi.mock('../azure-devops/client', () => ({
  getAzureDevOpsAuthStatus: getAzureDevOpsAuthStatusMock
}))
vi.mock('../gitea/client', () => ({ getGiteaAuthStatus: getGiteaAuthStatusMock }))

// Isolate the subprocess-spawn assertion from the fs-based install-dir fallback.
vi.mock('../../shared/local-agent-install-dir-detection', () => ({
  detectCommandsInInstallDirs: detectCommandsInInstallDirsMock
}))

// Win32 preflight env merge reads persisted registry PATH; stub it out.
vi.mock('../pty/windows-environment-path', () => ({
  mergePersistedWindowsPathAsync: mergePersistedWindowsPathAsyncMock,
  mergePersistedWindowsPath: mergePersistedWindowsPathMock
}))

import { _resetPreflightCache, detectInstalledAgents } from '../preflight/agent-detection'
import {
  getTuiAgentDetectionProbeCommands,
  KNOWN_TUI_AGENT_DETECTION_COMMANDS
} from '../../shared/tui-agent-detection-commands'

describe('#9297: local agent detection spawns zero where/which subprocesses', () => {
  const originalPlatform = process.platform
  const originalPath = process.env.PATH

  beforeEach(() => {
    execFileAsyncMock.mockReset()
    execFileMock.mockReset()
    execFileAsyncMock.mockImplementation(async (command: string) => {
      throw new Error(`unexpected subprocess spawn: ${command}`)
    })
    detectCommandsInInstallDirsMock.mockReset()
    detectCommandsInInstallDirsMock.mockReturnValue(new Set<string>())
    // Empty PATH makes results independent of installed host CLIs.
    process.env.PATH = ''
    _resetPreflightCache()
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    process.env.PATH = originalPath
  })

  for (const platform of ['win32', 'darwin'] as const) {
    it(`resolves via fs (no where/which spawn) on ${platform}`, async () => {
      Object.defineProperty(process, 'platform', { configurable: true, value: platform })

      const probeCommands = getTuiAgentDetectionProbeCommands(
        KNOWN_TUI_AGENT_DETECTION_COMMANDS,
        platform
      )
      expect(probeCommands.length).toBeGreaterThanOrEqual(20)

      const agents = await detectInstalledAgents()

      expect(execFileAsyncMock).toHaveBeenCalledTimes(0)
      expect(agents).toEqual([])
    })
  }
})
