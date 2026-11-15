import { describe, expect, it } from 'vitest'
import { ElectronSidecarTabRegistry } from './electron-sidecar-tab-registry'

const WORKTREE_ID = 'repo-42718::/srv/app'
const SIDECAR_PAGE_ID = 'sidecar-page-42718'
const PUBLIC_PAGE_ID = 'public-page-42718'

function unscopedSidecarTab(browserPageId: string, openerBrowserPageId?: string) {
  return {
    browserPageId,
    url: 'https://example.com/scoped',
    title: 'Scoped',
    active: openerBrowserPageId === undefined,
    worktreeId: null,
    ...(openerBrowserPageId ? { openerBrowserPageId } : {})
  }
}

describe('ElectronSidecarTabRegistry workspace scope', () => {
  it('projects the registered worktree onto a sidecar tab list row', () => {
    const tabs = new ElectronSidecarTabRegistry()
    tabs.register(SIDECAR_PAGE_ID, PUBLIC_PAGE_ID, WORKTREE_ID)

    expect(tabs.reconcileTabs([unscopedSidecarTab(SIDECAR_PAGE_ID)], WORKTREE_ID)).toEqual([
      {
        browserPageId: PUBLIC_PAGE_ID,
        index: 0,
        url: 'https://example.com/scoped',
        title: 'Scoped',
        active: true,
        worktreeId: WORKTREE_ID
      }
    ])
  })

  it('projects the registered worktree onto a tab show result', () => {
    const tabs = new ElectronSidecarTabRegistry()
    tabs.register(SIDECAR_PAGE_ID, PUBLIC_PAGE_ID, WORKTREE_ID)

    expect(tabs.rewriteResult({ tab: unscopedSidecarTab(SIDECAR_PAGE_ID) })).toEqual({
      tab: {
        browserPageId: PUBLIC_PAGE_ID,
        url: 'https://example.com/scoped',
        title: 'Scoped',
        active: true,
        worktreeId: WORKTREE_ID
      }
    })
  })

  it('projects the registered worktree onto a profile show result', () => {
    const tabs = new ElectronSidecarTabRegistry()
    tabs.register(SIDECAR_PAGE_ID, PUBLIC_PAGE_ID, WORKTREE_ID)

    expect(
      tabs.rewriteResult({
        browserPageId: SIDECAR_PAGE_ID,
        worktreeId: null,
        profileId: 'default',
        profileLabel: 'Default'
      })
    ).toEqual({
      browserPageId: PUBLIC_PAGE_ID,
      worktreeId: WORKTREE_ID,
      profileId: 'default',
      profileLabel: 'Default'
    })
  })

  it('projects an adopted popup onto the opener worktree', () => {
    const tabs = new ElectronSidecarTabRegistry()
    tabs.register(SIDECAR_PAGE_ID, PUBLIC_PAGE_ID, WORKTREE_ID)

    expect(
      tabs.reconcileTabs(
        [
          unscopedSidecarTab(SIDECAR_PAGE_ID),
          {
            ...unscopedSidecarTab('sidecar-popup-42718', SIDECAR_PAGE_ID),
            url: 'https://example.com/oauth',
            title: 'Sign in'
          }
        ],
        WORKTREE_ID
      )
    ).toEqual([
      {
        browserPageId: PUBLIC_PAGE_ID,
        index: 0,
        url: 'https://example.com/scoped',
        title: 'Scoped',
        active: true,
        worktreeId: WORKTREE_ID
      },
      {
        browserPageId: 'sidecar-popup-42718',
        index: 1,
        url: 'https://example.com/oauth',
        title: 'Sign in',
        active: false,
        worktreeId: WORKTREE_ID,
        openerBrowserPageId: PUBLIC_PAGE_ID
      }
    ])
  })
})
