import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as DistroGateModule from '../../wsl-background-distro-gate'
import type { Repo } from '../../../shared/repo-types'

const mocks = vi.hoisted(() => {
  const state: {
    distroState: 'running' | 'stopped' | 'unverifiable'
    gitOptions: { wslDistro?: string }
  } = { distroState: 'stopped', gitOptions: {} }
  return {
    state,
    handlers: new Map<string, (event: unknown, args: unknown) => Promise<unknown>>(),
    send: vi.fn(),
    getBaseRefDefault: vi.fn(async (_path: string, _options?: unknown) => 'origin/main'),
    getRemoteCount: vi.fn(async (_path: string, _options?: unknown) => 1)
  }
})

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: mocks.send } }]
  },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, args: unknown) => Promise<unknown>) =>
      mocks.handlers.set(channel, handler)
  }
}))
vi.mock('../../git/repo', () => ({
  getBaseRefDefault: mocks.getBaseRefDefault,
  getRemoteCount: mocks.getRemoteCount,
  searchBaseRefDetails: vi.fn(async () => [])
}))
vi.mock('../../project-runtime-git-options', () => ({
  getProjectRuntimeReadGitOptions: () => mocks.state.gitOptions
}))
vi.mock('../../wsl-background-distro-gate', async (importOriginal) => ({
  ...(await importOriginal<typeof DistroGateModule>()),
  readWslDistroRunningState: vi.fn(async () => mocks.state.distroState)
}))

import { registerBaseRefQueryHandlers } from './base-ref-query-handlers'
import {
  _resetWslBackgroundDistroGateForTests,
  noteWslDistrosRunning
} from '../../wsl-background-distro-gate'
import { RuntimeRepositoryRefQueries } from '../../runtime/runtime-repository-ref-queries'

const WSL_REPO = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo'
const UNKNOWN = { defaultBaseRef: null, remoteCount: 0 }
const REFUSED = { ...UNKNOWN, refusedWslDistro: 'Ubuntu' }
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: WSL_REPO,
    displayName: 'repo',
    badgeColor: '#000',
    addedAt: 1,
    kind: 'git',
    ...overrides
  }
}

function registerWith(repo: Repo): (args: Record<string, unknown>) => Promise<unknown> {
  const store = { getRepo: () => repo, getRepos: () => [repo] }
  registerBaseRefQueryHandlers(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only getRepo/getRepos, both provided.
    store as unknown as Parameters<typeof registerBaseRefQueryHandlers>[0]
  )
  const handler = mocks.handlers.get('repos:getBaseRefDefault')
  if (!handler) {
    throw new Error('repos:getBaseRefDefault was not registered')
  }
  return (args) => handler(null, { repoId: repo.id, ...args })
}

describe('repos:getBaseRefDefault for a stopped WSL distro (E9)', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    mocks.handlers.clear()
    mocks.send.mockClear()
    _resetWslBackgroundDistroGateForTests()
    mocks.state.distroState = 'stopped'
    mocks.state.gitOptions = {}
    mocks.getBaseRefDefault.mockClear()
    mocks.getRemoteCount.mockClear()
  })

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  })

  it('returns unknown without running Git when the Settings pane opens', async () => {
    const getDefault = registerWith(makeRepo())

    await expect(getDefault({})).resolves.toEqual(REFUSED)
    expect(mocks.getBaseRefDefault).not.toHaveBeenCalled()
    expect(mocks.getRemoteCount).not.toHaveBeenCalled()
  })

  it('tells renderers to re-ask once the refusing distro runs', async () => {
    const getDefault = registerWith(makeRepo())
    await getDefault({})
    expect(mocks.send).not.toHaveBeenCalled()

    noteWslDistrosRunning(['Ubuntu'])

    expect(mocks.send).toHaveBeenCalledWith('preflight:wslDistroRunning', 'Ubuntu')
  })

  it('refuses a host path whose Git runs through wsl.exe in a stopped distro', async () => {
    mocks.state.gitOptions = { wslDistro: 'Ubuntu' }
    const getDefault = registerWith(makeRepo({ path: 'C:\\src\\repo' }))

    await expect(getDefault({})).resolves.toEqual(REFUSED)
    expect(mocks.getBaseRefDefault).not.toHaveBeenCalled()
  })
})

describe('runtime repo.baseRefDefault for a stopped WSL distro (E9)', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    mocks.state.distroState = 'stopped'
    mocks.getBaseRefDefault.mockClear()
  })

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  })

  it('returns unknown, naming the refusing distro, without touching its UNC path', async () => {
    const queries = new RuntimeRepositoryRefQueries({ resolveRepo: async () => makeRepo() })

    await expect(queries.getDefault('id:repo-1')).resolves.toEqual(REFUSED)
    expect(mocks.getBaseRefDefault).not.toHaveBeenCalled()
  })
})
