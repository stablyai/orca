import { vi, type Mock } from 'vitest'
import { isWslUncPath } from '../../shared/wsl-paths'

export type PRRefreshCoordinatorMocks = {
  sendMock: Mock
  sendToTrustedUIRendererMock: Mock
  getAllWebContentsMock: Mock
  getPRForBranchOutcomeMock: Mock
  getOriginGitHubApiRepositoryMock: Mock
  getRateLimitMock: Mock
  noteRepositoryRateLimitSpendMock: Mock
  repositoryRateLimitGuardMock: Mock
  spendsSharedGitHubComQuotaMock: Mock
}

// Why: every coordinator suite registers its own `vi.mock` factories (hoisting
// is per-file), so the mock set and the factory bodies live here and each test
// file only wires them together.
export function createPRRefreshCoordinatorMocks(): PRRefreshCoordinatorMocks {
  return {
    sendMock: vi.fn(),
    sendToTrustedUIRendererMock: vi.fn(),
    getAllWebContentsMock: vi.fn(),
    getPRForBranchOutcomeMock: vi.fn(),
    getOriginGitHubApiRepositoryMock: vi.fn(),
    getRateLimitMock: vi.fn(),
    noteRepositoryRateLimitSpendMock: vi.fn(),
    repositoryRateLimitGuardMock: vi.fn(),
    spendsSharedGitHubComQuotaMock: vi.fn()
  }
}

export type ElectronModuleMock = { webContents: { getAllWebContents: Mock } }

export function electronModuleMock(mocks: PRRefreshCoordinatorMocks): ElectronModuleMock {
  return {
    webContents: {
      getAllWebContents: mocks.getAllWebContentsMock
    }
  }
}

export type ClientModuleMock = { getPRForBranchOutcome: Mock }

export function clientModuleMock(mocks: PRRefreshCoordinatorMocks): ClientModuleMock {
  return {
    getPRForBranchOutcome: mocks.getPRForBranchOutcomeMock
  }
}

export type GithubApiRepositoryModuleMock = { getOriginGitHubApiRepository: Mock }

export function githubApiRepositoryModuleMock(
  mocks: PRRefreshCoordinatorMocks
): GithubApiRepositoryModuleMock {
  return {
    getOriginGitHubApiRepository: mocks.getOriginGitHubApiRepositoryMock
  }
}

export type RateLimitModuleMock = {
  getRateLimit: Mock
  noteRepositoryRateLimitSpend: Mock
  repositoryRateLimitGuard: Mock
  spendsSharedGitHubComQuota: Mock
}

export function rateLimitModuleMock(mocks: PRRefreshCoordinatorMocks): RateLimitModuleMock {
  return {
    getRateLimit: mocks.getRateLimitMock,
    noteRepositoryRateLimitSpend: mocks.noteRepositoryRateLimitSpendMock,
    repositoryRateLimitGuard: mocks.repositoryRateLimitGuardMock,
    spendsSharedGitHubComQuota: mocks.spendsSharedGitHubComQuotaMock
  }
}

export type IpcUiModuleMock = { sendToTrustedUIRenderer: Mock }

export function ipcUiModuleMock(mocks: PRRefreshCoordinatorMocks): IpcUiModuleMock {
  return {
    sendToTrustedUIRenderer: mocks.sendToTrustedUIRendererMock
  }
}

// The coordinator keeps module-level queue state; reset modules and timers so
// one suite's pending work cannot leak into the next test.
export function resetPRRefreshCoordinatorMocks(mocks: PRRefreshCoordinatorMocks): void {
  const {
    sendMock,
    sendToTrustedUIRendererMock,
    getAllWebContentsMock,
    getPRForBranchOutcomeMock,
    getOriginGitHubApiRepositoryMock,
    getRateLimitMock,
    noteRepositoryRateLimitSpendMock,
    repositoryRateLimitGuardMock,
    spendsSharedGitHubComQuotaMock
  } = mocks
  vi.resetModules()
  vi.useFakeTimers()
  vi.setSystemTime(1_000)
  sendMock.mockReset()
  sendToTrustedUIRendererMock.mockReset()
  sendToTrustedUIRendererMock.mockImplementation((channel, payload) => {
    sendMock(channel, payload)
  })
  getAllWebContentsMock.mockReset()
  getPRForBranchOutcomeMock.mockReset()
  getOriginGitHubApiRepositoryMock.mockReset()
  getOriginGitHubApiRepositoryMock.mockResolvedValue({
    owner: 'acme',
    repo: 'widgets',
    host: 'github.com'
  })
  getRateLimitMock.mockReset()
  noteRepositoryRateLimitSpendMock.mockReset()
  repositoryRateLimitGuardMock.mockReset()
  repositoryRateLimitGuardMock.mockReturnValue({ blocked: false })
  spendsSharedGitHubComQuotaMock.mockReset()
  spendsSharedGitHubComQuotaMock.mockImplementation(
    (repository: { host?: string } | null, options?: { cwd?: string; wslDistro?: string }) =>
      (!repository?.host || repository.host.toLowerCase() === 'github.com') &&
      !options?.wslDistro &&
      !(options?.cwd && isWslUncPath(options.cwd))
  )
  getAllWebContentsMock.mockReturnValue([
    {
      id: 1,
      isDestroyed: () => false,
      send: sendMock
    }
  ])
  getRateLimitMock.mockResolvedValue({ ok: true })
}
