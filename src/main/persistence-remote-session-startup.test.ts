import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getDefaultWorkspaceSession } from '../shared/constants'
import type { BrowserPage, BrowserWorkspace } from '../shared/browser-workspace-types'
import { createStore, makeRepo, testState } from './persistence-test-harness'

vi.mock('./ssh/ssh-config-parser', () => ({
  loadUserSshConfig: vi.fn(),
  sshConfigHostsToTargets: vi.fn()
}))
vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('./telemetry/client', () => ({ track: vi.fn() }))
vi.mock('./telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn().mockReturnValue({}) }))

const HOST = 'runtime:paired-host'
const REPO = 'remote-repo'
const WORKTREE = `${REPO}::/remote/project`
const PAGE: BrowserPage = {
  id: 'page-1',
  workspaceId: 'browser-1',
  worktreeId: WORKTREE,
  url: 'https://example.test/moved',
  title: 'Moved page',
  loading: false,
  canGoBack: true,
  canGoForward: false,
  faviconUrl: null,
  loadError: null,
  createdAt: 1,
  browserRuntimeEnvironmentId: 'paired-host',
  remoteBrowserPageId: 'remote-page-1',
  remoteBrowserPageClientHosted: true
}
const BROWSER: BrowserWorkspace = {
  id: PAGE.workspaceId,
  worktreeId: WORKTREE,
  sessionProfileId: null,
  activePageId: PAGE.id,
  pageIds: [PAGE.id],
  url: PAGE.url,
  title: PAGE.title,
  loading: false,
  faviconUrl: null,
  canGoBack: true,
  canGoForward: false,
  loadError: null,
  createdAt: 1
}

function browserSession() {
  return {
    ...getDefaultWorkspaceSession(),
    browserTabsByWorktree: { [WORKTREE]: [BROWSER] },
    browserPagesByWorkspace: { [BROWSER.id]: [PAGE] },
    activeBrowserTabIdByWorktree: { [WORKTREE]: BROWSER.id }
  }
}

describe('remote session startup ownership', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-remote-session-'))
  })
  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('keeps a paired browser row and its hosting identity across two Store reloads', () => {
    const seed = createStore()
    seed.addRepo(makeRepo({ id: 'local-repo', path: join(testState.dir, 'local') }))
    seed.setWorkspaceSession(browserSession(), HOST)
    seed.flush()

    for (let i = 0; i < 2; i += 1) {
      const reloaded = createStore()
      expect(reloaded.getWorkspaceSession(HOST).browserPagesByWorkspace).toEqual({
        [BROWSER.id]: [PAGE]
      })
      expect(reloaded.sweepDeregisteredRepoResidue()).toEqual([])
      reloaded.flush()
    }
  })

  it('retains remote metadata when no session or local catalog row names its repo', () => {
    const seed = createStore()
    seed.setWorktreeMetaForHost(WORKTREE, HOST, { displayName: 'Remote work' })
    seed.flush()
    const reloaded = createStore()
    expect(reloaded.getWorktreeMeta(WORKTREE)).toMatchObject({ displayName: 'Remote work' })
    expect(reloaded.sweepDeregisteredRepoResidue()).toEqual([])
    reloaded.flush()
  })

  it('still applies an explicit remote project removal', () => {
    const seed = createStore()
    seed.setWorkspaceSession(browserSession(), HOST)
    seed.flush()
    const reloaded = createStore()
    // Assert the row survived load first, or an empty partition below would prove nothing.
    expect(reloaded.getWorkspaceSession(HOST).browserPagesByWorkspace).not.toEqual({})
    reloaded.removeProjectForHost(REPO, HOST)
    reloaded.flush()
    expect(createStore().getWorkspaceSession(HOST).browserPagesByWorkspace).toEqual({})
  })
})
