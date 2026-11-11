import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import {
  persistClientHostedBrowserPages,
  rehydrateClientHostedBrowserPages
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

  it('never rehydrates over a page the registry already holds', () => {
    const store = sessionStore()
    persistClientHostedBrowserPages(store, registryWith(livePlacement), 'repo-1::wt-a')
    const live = registryWith(livePlacement)
    // The registry already rejects duplicates; warnings distinguish skipped replay from a noisy rejected attempt.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let warnings = -1
    try {
      rehydrateClientHostedBrowserPages(live, {
        listWorkspaceSessions: () => [store.session],
        isKnownWorktree: () => true,
        now: () => NOW
      })
      // mockRestore clears calls too; capture the count first.
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
