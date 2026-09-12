import { describe, expect, it } from 'vitest'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { preserveRuntimeAuthoredWorkspaceSessionFields } from './runtime-authored-workspace-session-fields'

const row = {
  v: 1 as const,
  browserPageId: 'page-a',
  workspaceId: 'repo-1::wt-a',
  browserProfileId: 'profile-a',
  executionHostKey: 'native:runtime-a:1',
  url: 'https://kept.internal/',
  title: 'Kept',
  pairedDeviceId: 'device-a',
  savedAt: 1_800_000_000_000
}

describe('preserving runtime-authored workspace session fields', () => {
  it('carries the rows across a write that never mentions them', () => {
    // The desktop renderer builds its payload from Zustand, which has no idea the runtime
    // authority sharing this profile persists client-hosted pages.
    const next = preserveRuntimeAuthoredWorkspaceSessionFields(
      session(),
      session({ 'repo-1::wt-a': [row] })
    )

    expect(next.clientHostedBrowserPagesByWorktree).toEqual({ 'repo-1::wt-a': [row] })
  })

  it('lets the runtime clear its own rows, which it does with an empty map', () => {
    const next = preserveRuntimeAuthoredWorkspaceSessionFields(
      session({}),
      session({ 'repo-1::wt-a': [row] })
    )

    expect(next.clientHostedBrowserPagesByWorktree).toEqual({})
  })

  it('lets the runtime replace its rows outright', () => {
    const replaced = { 'repo-1::wt-b': [{ ...row, workspaceId: 'repo-1::wt-b' }] }

    expect(
      preserveRuntimeAuthoredWorkspaceSessionFields(
        session(replaced),
        session({ 'repo-1::wt-a': [row] })
      ).clientHostedBrowserPagesByWorktree
    ).toEqual(replaced)
  })

  it('treats an explicit undefined as never having mentioned the field', () => {
    // The one ambiguous input: a writer that spreads the field through as undefined is still a
    // writer that knows nothing about it, so it must inherit rather than clear.
    const next = preserveRuntimeAuthoredWorkspaceSessionFields(
      { ...session(), clientHostedBrowserPagesByWorktree: undefined },
      session({ 'repo-1::wt-a': [row] })
    )

    expect(next.clientHostedBrowserPagesByWorktree).toEqual({ 'repo-1::wt-a': [row] })
  })

  it('leaves an untouched write alone rather than inventing a field', () => {
    const next = session()

    expect(preserveRuntimeAuthoredWorkspaceSessionFields(next, session())).toBe(next)
    expect(preserveRuntimeAuthoredWorkspaceSessionFields(next, null)).toBe(next)
  })
})

function session(
  clientHostedBrowserPagesByWorktree?: WorkspaceSessionState['clientHostedBrowserPagesByWorktree']
): WorkspaceSessionState {
  return {
    activeRepoId: null,
    activeWorktreeId: null,
    activeTabId: null,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    ...(clientHostedBrowserPagesByWorktree ? { clientHostedBrowserPagesByWorktree } : {})
  }
}
