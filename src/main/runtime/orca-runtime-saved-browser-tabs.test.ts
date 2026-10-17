import './orca-runtime-test-lifecycle.spec'
import { describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime-test-mocks.spec'
import {
  TEST_WORKTREE_ID,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from './orca-runtime-test-fixtures.spec'
import type { BrowserWorkspace } from '../../shared/browser-workspace-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { RuntimeStore } from './runtime-store-contract'

function savedBrowserTab(): BrowserWorkspace {
  return {
    id: 'browser-tab',
    worktreeId: TEST_WORKTREE_ID,
    url: 'http://localhost:3000',
    title: 'Preview',
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 1
  }
}

function runtimeWithSession(overrides: Partial<WorkspaceSessionState>): OrcaRuntimeService {
  const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
    makeWorkspaceSessionWithHeadlessTerminal(overrides)
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The shared fixture implements RuntimeStore; its annotation erases the Vitest mock call signatures.
  return new OrcaRuntimeService(runtimeStore as RuntimeStore)
}

function hasSavedBrowserTabs(runtime: OrcaRuntimeService, worktreeId: string | undefined) {
  return runtime['hasSavedBrowserTabs'](worktreeId)
}

// Why: `orca tab list` cuts the browser registration wait to a short grace when this answers false (#20434), so a wrong false would hide saved tabs right after a restart.
describe('saved browser tabs for the browser wake', () => {
  it('answers false for a worktree whose saved session has no browser tab', () => {
    const runtime = runtimeWithSession({ browserTabsByWorktree: { [TEST_WORKTREE_ID]: [] } })

    expect(hasSavedBrowserTabs(runtime, TEST_WORKTREE_ID)).toBe(false)
  })

  it('answers true for a worktree with a saved browser tab, named or focused', () => {
    const runtime = runtimeWithSession({
      browserTabsByWorktree: { [TEST_WORKTREE_ID]: [savedBrowserTab()] }
    })

    expect(hasSavedBrowserTabs(runtime, TEST_WORKTREE_ID)).toBe(true)
    expect(hasSavedBrowserTabs(runtime, undefined)).toBe(true)
  })

  it('answers false for the focused worktree when its saved session has no browser tab', () => {
    const runtime = runtimeWithSession({ browserTabsByWorktree: {} })

    expect(hasSavedBrowserTabs(runtime, undefined)).toBe(false)
  })

  it('keeps waiting when there is no focused worktree to check', () => {
    const runtime = runtimeWithSession({ activeWorktreeId: null, browserTabsByWorktree: {} })

    expect(hasSavedBrowserTabs(runtime, undefined)).toBe(true)
  })
})
