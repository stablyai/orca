import { vi } from 'vitest'
import { clearPRRefreshValidationBackoffForTests } from '../github/pr-refresh-validation-backoff'
import { type GitHubIpcMocks, listGitHubIpcMockFns } from './github-ipc-module-mocks'

const ORIGINAL_PLATFORM = process.platform

export function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: platform
  })
}

export type HandlerMap = Record<string, (_event: unknown, args: unknown) => unknown>

export type FixtureRepo = {
  id: string
  path: string
  displayName: string
  badgeColor: string
  addedAt: number
  connectionId?: string | null
  executionHostId?: string | null
  issueSourcePreference?: 'origin' | 'upstream'
}

export type FixtureProject = {
  id: string
  displayName: string
  badgeColor: string
  sourceRepoIds: string[]
  localWindowsRuntimePreference?: { kind: 'wsl'; distro: string }
  createdAt: number
  updatedAt: number
}

export type GitHubIpcHarness = {
  handlers: HandlerMap
  repos: FixtureRepo[]
  projects: FixtureProject[]
  store: {
    getRepos: () => FixtureRepo[]
    getProjects: () => FixtureProject[]
    getSettings: () => { localWindowsRuntimeDefault: { kind: string } }
  }
  stats: { hasCountedPR: () => boolean; record: () => void }
  reset: () => void
}

function defaultRepos(): FixtureRepo[] {
  return [
    {
      id: 'repo-1',
      path: '/workspace/repo',
      displayName: 'repo',
      badgeColor: '#000',
      addedAt: 0
    }
  ]
}

export function createGitHubIpcHarness(mocks: GitHubIpcMocks): GitHubIpcHarness {
  const handlers: HandlerMap = {}
  const harness: GitHubIpcHarness = {
    handlers,
    repos: defaultRepos(),
    projects: [],
    store: {
      getRepos: () => harness.repos,
      getProjects: () => harness.projects,
      getSettings: () => ({ localWindowsRuntimeDefault: { kind: 'windows-host' } })
    },
    stats: {
      hasCountedPR: () => false,
      record: vi.fn()
    },
    reset: () => {
      setPlatform(ORIGINAL_PLATFORM)
      for (const fn of listGitHubIpcMockFns(mocks)) {
        fn.mockReset()
      }
      mocks.cohort.getCohortAtEmit.mockReturnValue({ nth_repo_added: undefined })
      mocks.electron.webContents.getAllWebContents.mockReturnValue([])
      clearPRRefreshValidationBackoffForTests()
      for (const key of Object.keys(handlers)) {
        delete handlers[key]
      }

      // Reset fixture repos to the default single-repo fixture each test, so
      // individual tests can mutate the list without leaking preferences across
      // tests (e.g. a preference-threading test could otherwise shadow the
      // default-undefined assertions in sibling tests).
      harness.repos = defaultRepos()
      harness.projects = []

      mocks.electron.ipcMain.handle.mockImplementation((channel: string, handler) => {
        handlers[channel] = handler
      })
    }
  }
  return harness
}
