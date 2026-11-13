import type { PRRefreshRendererPort } from './pr-refresh-renderer-port'
import type {
  PreparedPRBranchRead,
  preparePRBranchRead
} from '../../client/lookup/pr-for-branch-outcome'
import { vi, type Mock } from 'vitest'
import { isWslUncPath } from '../../../../shared/wsl-paths'

type PRRefreshWebContentsMock = {
  id: number
  isDestroyed: () => boolean
  send?: Mock
}

export type PRRefreshCoordinatorMocks = {
  sendMock: Mock
  sendToTrustedUIRendererMock: Mock
  getAllWebContentsMock: Mock<() => PRRefreshWebContentsMock[]>
  webContentsFromIdMock: Mock<(id: number) => PRRefreshWebContentsMock | undefined>
  getPRForBranchOutcomeMock: Mock
  getOriginGitHubApiRepositoryMock: Mock
  getRateLimitMock: Mock
  noteRepositoryRateLimitSpendMock: Mock
  repositoryRateLimitGuardMock: Mock
  spendsSharedGitHubComQuotaMock: Mock
}

// Vitest hoists per file; suites register these shared factories locally.
export function createPRRefreshCoordinatorMocks(): PRRefreshCoordinatorMocks {
  return {
    sendMock: vi.fn(),
    sendToTrustedUIRendererMock: vi.fn(),
    getAllWebContentsMock: vi.fn(),
    webContentsFromIdMock: vi.fn(),
    getPRForBranchOutcomeMock: vi.fn(),
    getOriginGitHubApiRepositoryMock: vi.fn(),
    getRateLimitMock: vi.fn(),
    noteRepositoryRateLimitSpendMock: vi.fn(),
    repositoryRateLimitGuardMock: vi.fn(),
    spendsSharedGitHubComQuotaMock: vi.fn()
  }
}

export type RendererPortModuleMock = { prRefreshRenderers: () => PRRefreshRendererPort }

/** Renderers are the mocked web contents; refresh events reach `sendToTrustedUIRendererMock`. */
export function rendererPortModuleMock(mocks: PRRefreshCoordinatorMocks): RendererPortModuleMock {
  const port: PRRefreshRendererPort = {
    isRendererOpen: (id) => {
      const contents = mocks.webContentsFromIdMock(id)
      return contents !== undefined && !contents.isDestroyed()
    },
    sendToTrustedUI: (channel, payload) => mocks.sendToTrustedUIRendererMock(channel, payload)
  }
  return { prRefreshRenderers: () => port }
}

export type ClientModuleMock = {
  getPRForBranchOutcome: Mock
  preparePRBranchRead: typeof preparePRBranchRead
}

export function clientModuleMock(mocks: PRRefreshCoordinatorMocks): ClientModuleMock {
  return {
    getPRForBranchOutcome: mocks.getPRForBranchOutcomeMock,
    preparePRBranchRead: async (...args) => {
      const prepared: PreparedPRBranchRead = {
        key: '',
        reprepare: async () => prepared,
        cached: () => null,
        isCurrent: () => true,
        accepts: () => true,
        didRead: () => true,
        release: () => {},
        hold: () => () => {},
        canRetain: () => true,
        scheduleError: () => {},
        pending: () => null,
        withExecution: (operation) => operation(),
        read: async (settle) => {
          const outcome = await mocks.getPRForBranchOutcomeMock(...args)
          return settle ? settle(outcome) : outcome
        },
        readRetained: async (settle) => {
          const outcome = await mocks.getPRForBranchOutcomeMock(...args)
          return settle ? settle(outcome) : outcome
        }
      }
      return prepared
    }
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

// Module queues and timers must not leak pending work between tests.
export function resetPRRefreshCoordinatorMocks(mocks: PRRefreshCoordinatorMocks): void {
  const {
    sendMock,
    sendToTrustedUIRendererMock,
    getAllWebContentsMock,
    webContentsFromIdMock,
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
  webContentsFromIdMock.mockReset()
  webContentsFromIdMock.mockImplementation((id) =>
    getAllWebContentsMock().find((contents) => contents.id === id)
  )
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
