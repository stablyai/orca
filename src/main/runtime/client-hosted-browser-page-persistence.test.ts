import { describe, expect, it, vi } from 'vitest'
import {
  CLIENT_HOSTED_BROWSER_PAGE_MAX_AGE_MS,
  CLIENT_HOSTED_BROWSER_PAGE_REFRESH_MS,
  persistedClientHostedBrowserPageSchema
} from '../../shared/client-hosted-browser-page-record'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { parseWorkspaceSessionSalvaging } from '../../shared/workspace-session-salvage'
import {
  isRestoredClientHostedBrowserPlacement,
  persistClientHostedBrowserPages,
  rehydrateClientHostedBrowserPages,
  RESTORED_CLIENT_HOSTED_BROWSER_PLACEMENT,
  RESTORED_CLIENT_HOSTED_EXECUTION_HOST_KEY
} from './client-hosted-browser-page-persistence'
import { RuntimeBrowserPageRegistry } from './runtime-browser-page-registry'

const NOW = 1_800_000_000_000

const livePlacement = Object.freeze({
  kind: 'client' as const,
  browserHostClientId: 'host-a',
  browserHostGeneration: 4,
  pageHostGeneration: 7
})

describe('client-hosted browser page persistence', () => {
  it('writes a client page and rehydrates it into a held row', () => {
    const store = sessionStore()
    const pages = registryWith(livePlacement)

    expect(persistClientHostedBrowserPages(store, pages, 'repo-1::wt-a')).toBe(true)

    const restored = new RuntimeBrowserPageRegistry()
    rehydrateClientHostedBrowserPages(restored, {
      listWorkspaceSessions: () => [store.session],
      isKnownWorktree: () => true,
      now: () => NOW
    })

    expect(restored.getPage('page-a')).toMatchObject({
      browserPageId: 'page-a',
      workspaceId: 'repo-1::wt-a',
      browserProfileId: 'profile-a',
      // Never the key it was created under: that one names the runtime process that minted it.
      executionHostKey: RESTORED_CLIENT_HOSTED_EXECUTION_HOST_KEY,
      pairedDeviceId: 'device-a',
      url: 'https://kept.internal/',
      title: 'Kept',
      // A held row: nothing is driving it, and it claims no focus from whatever the host shows.
      loading: false,
      active: false
    })
    expect(isRestoredClientHostedBrowserPlacement(restored.getPage('page-a')!.placement)).toBe(true)
  })

  it('persists no authority: a rehydrated placement can never equal a mintable one', () => {
    // Generation counters start at 1 and only ever increase, so the sentinel's 0s are unreachable.
    expect(RESTORED_CLIENT_HOSTED_BROWSER_PLACEMENT.browserHostGeneration).toBe(0)
    expect(RESTORED_CLIENT_HOSTED_BROWSER_PLACEMENT.pageHostGeneration).toBe(0)
    expect(isRestoredClientHostedBrowserPlacement(livePlacement)).toBe(false)

    const store = sessionStore()
    persistClientHostedBrowserPages(store, registryWith(livePlacement), 'repo-1::wt-a')
    const [row] = store.session.clientHostedBrowserPagesByWorktree!['repo-1::wt-a']!

    // The persisted row's keys are the whole durable contract; anything naming an authority here
    // would be a forgery the next epoch could not distinguish from a live placement.
    expect(Object.keys(row).sort()).toEqual([
      'browserPageId',
      'browserProfileId',
      'pairedDeviceId',
      'savedAt',
      'title',
      'url',
      'v',
      'workspaceId'
    ])
  })

  it('skips a rewrite when the projection is unchanged', () => {
    const store = sessionStore()
    const pages = registryWith(livePlacement)

    expect(persistClientHostedBrowserPages(store, pages, 'repo-1::wt-a')).toBe(true)
    expect(persistClientHostedBrowserPages(store, pages, 'repo-1::wt-a')).toBe(false)
    expect(store.setWorkspaceSession).toHaveBeenCalledOnce()
  })

  it('refreshes a parked tab so the expiry measures held-ness, not last change', () => {
    let now = NOW
    const store = sessionStore()
    store.now = () => now
    const pages = registryWith(livePlacement)
    persistClientHostedBrowserPages(store, pages, 'repo-1::wt-a')

    now = NOW + CLIENT_HOSTED_BROWSER_PAGE_REFRESH_MS + 1
    expect(persistClientHostedBrowserPages(store, pages, 'repo-1::wt-a')).toBe(true)

    expect(store.session.clientHostedBrowserPagesByWorktree?.['repo-1::wt-a']?.[0]?.savedAt).toBe(
      now
    )
    // Still cheap in between: a tab whose page did not change does not rewrite on every call.
    expect(persistClientHostedBrowserPages(store, pages, 'repo-1::wt-a')).toBe(false)
  })

  it('drops the worktree entry once its last page retires', () => {
    const store = sessionStore()
    const pages = registryWith(livePlacement)
    persistClientHostedBrowserPages(store, pages, 'repo-1::wt-a')

    pages.retirePage('page-a', livePlacement)
    expect(persistClientHostedBrowserPages(store, pages, 'repo-1::wt-a')).toBe(true)

    expect(store.session.clientHostedBrowserPagesByWorktree).toEqual({})
  })

  it('survives a worktree that no longer resolves instead of throwing', () => {
    const store = sessionStore()
    store.setWorkspaceSession.mockImplementation(() => {
      throw new Error('folder_workspace_not_found')
    })

    expect(() =>
      persistClientHostedBrowserPages(store, registryWith(livePlacement), 'repo-1::wt-a')
    ).not.toThrow()
  })

  it('never rehydrates a row whose worktree is gone', () => {
    const store = sessionStore()
    persistClientHostedBrowserPages(store, registryWith(livePlacement), 'repo-1::wt-a')
    const restored = new RuntimeBrowserPageRegistry()

    rehydrateClientHostedBrowserPages(restored, {
      listWorkspaceSessions: () => [store.session],
      isKnownWorktree: () => false,
      now: () => NOW
    })

    expect(restored.listPages()).toEqual([])
  })

  it('drops a row whose host never came back within the expiry bound', () => {
    const store = sessionStore()
    persistClientHostedBrowserPages(store, registryWith(livePlacement), 'repo-1::wt-a')
    const restored = new RuntimeBrowserPageRegistry()

    rehydrateClientHostedBrowserPages(restored, {
      listWorkspaceSessions: () => [store.session],
      isKnownWorktree: () => true,
      now: () => NOW + CLIENT_HOSTED_BROWSER_PAGE_MAX_AGE_MS + 1
    })

    expect(restored.listPages()).toEqual([])
  })

  it('never rehydrates over a page the registry already holds', () => {
    const store = sessionStore()
    persistClientHostedBrowserPages(store, registryWith(livePlacement), 'repo-1::wt-a')
    const live = registryWith(livePlacement)
    // Why the warning is the assertion: the registry refuses a duplicate publish on its own, so
    // outcome alone cannot tell a skipped attempt from a rejected one — and only the skip is
    // silent. A rejected one would log on every start for every page the registry already had.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let warnings = -1
    try {
      rehydrateClientHostedBrowserPages(live, {
        listWorkspaceSessions: () => [store.session],
        isKnownWorktree: () => true,
        now: () => NOW
      })
      // Read before restoring: mockRestore also resets the recorded calls.
      warnings = warn.mock.calls.length
    } finally {
      warn.mockRestore()
    }

    expect(live.getPage('page-a')?.placement).toEqual(livePlacement)
    expect(warnings).toBe(0)
  })

  it('ignores a row whose worktree key disagrees with its own workspace', () => {
    const store = sessionStore()
    persistClientHostedBrowserPages(store, registryWith(livePlacement), 'repo-1::wt-a')
    const misfiled: WorkspaceSessionState = {
      ...store.session,
      clientHostedBrowserPagesByWorktree: {
        'repo-1::wt-b': store.session.clientHostedBrowserPagesByWorktree!['repo-1::wt-a']!
      }
    }
    const restored = new RuntimeBrowserPageRegistry()

    rehydrateClientHostedBrowserPages(restored, {
      listWorkspaceSessions: () => [misfiled],
      isKnownWorktree: () => true,
      now: () => NOW
    })

    expect(restored.listPages()).toEqual([])
  })
})

describe('persisted client-hosted browser page schema', () => {
  const valid = {
    v: 1,
    browserPageId: 'page-a',
    workspaceId: 'repo-1::wt-a',
    browserProfileId: 'profile-a',
    url: 'https://kept.internal/',
    title: 'Kept',
    pairedDeviceId: 'device-a',
    savedAt: NOW
  }

  it('accepts a row this build wrote', () => {
    expect(persistedClientHostedBrowserPageSchema.safeParse(valid).success).toBe(true)
  })

  it.each([
    ['a newer schema version', { v: 2 }],
    ['a version this build predates', { v: 0 }],
    ['a missing version', { v: undefined }],
    ['an empty page id', { browserPageId: '' }],
    ['a missing paired device', { pairedDeviceId: undefined }],
    ['a non-integer timestamp', { savedAt: 1.5 }]
  ])('refuses %s rather than partly trusting it', (_why, override) => {
    expect(
      persistedClientHostedBrowserPageSchema.safeParse({ ...valid, ...override }).success
    ).toBe(false)
  })

  it('drops only the unreadable rows and keeps their siblings', () => {
    const parsed = parseWorkspaceSessionSalvaging({
      activeRepoId: null,
      activeWorktreeId: null,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      clientHostedBrowserPagesByWorktree: {
        'repo-1::wt-a': [valid, { ...valid, v: 99, browserPageId: 'page-future' }]
      }
    })

    expect(parsed.ok && parsed.value.clientHostedBrowserPagesByWorktree?.['repo-1::wt-a']).toEqual([
      valid
    ])
    expect(parsed.ok && parsed.droppedCount).toBe(1)
  })

  it('strips a field the schema does not declare, so authority cannot ride along', () => {
    const smuggled = persistedClientHostedBrowserPageSchema.parse({
      ...valid,
      browserHostGeneration: 4,
      pageHostGeneration: 7,
      connectionId: 'conn-a',
      executionHostKey: 'native:runtime-a:1'
    })

    expect(smuggled).toEqual(valid)
  })
})

function sessionStore() {
  const state = {
    session: {
      activeRepoId: null,
      activeWorktreeId: null,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {}
    } as WorkspaceSessionState,
    setWorkspaceSession: vi.fn((_worktreeId: string, next: WorkspaceSessionState) => {
      state.session = next
    }),
    getWorkspaceSession: (_worktreeId: string) => state.session,
    now: () => NOW as number
  }
  return state
}

function registryWith(placement: typeof livePlacement): RuntimeBrowserPageRegistry {
  const pages = new RuntimeBrowserPageRegistry()
  pages.publishClientPage({
    browserPageId: 'page-a',
    workspaceId: 'repo-1::wt-a',
    browserProfileId: 'profile-a',
    executionHostKey: 'native:runtime-a:1',
    placement,
    pairedDeviceId: 'device-a',
    url: 'https://kept.internal/',
    title: 'Kept',
    loading: true,
    active: true
  })
  return pages
}
