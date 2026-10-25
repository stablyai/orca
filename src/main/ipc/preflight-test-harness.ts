import path from 'node:path'
import type { Mock } from 'vitest'
import { _resetPreflightCache } from '../preflight/agent-detection'

export type HandlerMap = Record<string, (_event?: unknown, args?: unknown) => Promise<unknown>>

export type PreflightMocks = {
  handleMock: Mock
  execFileAsyncMock: Mock
  runWslProcessMock?: Mock
  hydrateShellPathMock: Mock
  mergePathSegmentsMock: Mock
  getBitbucketAuthStatusMock: Mock
  getAzureDevOpsAuthStatusMock: Mock
  getGiteaAuthStatusMock: Mock
  resolveCliCommandsMock: Mock
  isCommandOnLocalPathMock: Mock
  listLocalCommandPathsMock: Mock
  mergePersistedWindowsPathAsyncMock: Mock
  mergePersistedWindowsPathMock: Mock
}

export const defaultBitbucketStatus = { configured: false, authenticated: false, account: null }

export const defaultAzureDevOpsStatus = {
  configured: false,
  authenticated: false,
  account: null,
  baseUrl: null,
  tokenConfigured: false
}

export const defaultGiteaStatus = {
  configured: false,
  authenticated: false,
  account: null,
  baseUrl: null,
  tokenConfigured: false
}

export function resetPreflightMocks(mocks: PreflightMocks, handlers: HandlerMap): void {
  const {
    handleMock,
    execFileAsyncMock,
    runWslProcessMock,
    hydrateShellPathMock,
    mergePathSegmentsMock,
    getBitbucketAuthStatusMock,
    getAzureDevOpsAuthStatusMock,
    getGiteaAuthStatusMock,
    resolveCliCommandsMock,
    isCommandOnLocalPathMock,
    listLocalCommandPathsMock,
    mergePersistedWindowsPathAsyncMock,
    mergePersistedWindowsPathMock
  } = mocks

  handleMock.mockReset()
  execFileAsyncMock.mockReset()
  runWslProcessMock?.mockReset()
  hydrateShellPathMock.mockReset()
  hydrateShellPathMock.mockResolvedValue({ segments: [], ok: false, failureReason: 'no_shell' })
  mergePathSegmentsMock.mockReset()
  // No filesystem candidates keeps bare command names for tests using the existing lookup/exec mocks.
  listLocalCommandPathsMock.mockReset()
  listLocalCommandPathsMock.mockResolvedValue([])
  getBitbucketAuthStatusMock.mockReset()
  getAzureDevOpsAuthStatusMock.mockReset()
  getGiteaAuthStatusMock.mockReset()
  mergePersistedWindowsPathAsyncMock.mockReset()
  mergePersistedWindowsPathAsyncMock.mockResolvedValue(undefined)
  mergePersistedWindowsPathMock.mockReset()
  // Keep install-directory fallback opt-in for cases that otherwise use only the command lookup mock.
  resolveCliCommandsMock.mockReset()
  resolveCliCommandsMock.mockImplementation(
    (commands: string[]) => new Map(commands.map((command) => [command, command]))
  )
  // Preserve existing lookup fixtures while production uses filesystem PATH resolution (#9297).
  isCommandOnLocalPathMock.mockReset()
  isCommandOnLocalPathMock.mockImplementation(async (command: string) => {
    const finder = process.platform === 'win32' ? 'where' : 'which'
    try {
      const { stdout } = await execFileAsyncMock(finder, [command])
      return String(stdout)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .some((line) => path.isAbsolute(line))
    } catch {
      return false
    }
  })
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
}
