import { afterEach, describe, expect, it, vi } from 'vitest'

const owners = vi.hoisted(() => ({
  tabByGuest: new Map<number, string>(),
  worktreeByTab: new Map<string, string>(),
  urlByContents: new Map<number, string>()
}))

vi.mock('electron', () => ({
  webContents: {
    fromId: (id: number) => {
      const url = owners.urlByContents.get(id)
      return url === undefined ? undefined : { isDestroyed: () => false, getURL: () => url }
    }
  }
}))

vi.mock('../browser-manager', () => ({
  browserManager: {
    getOwningTabIdForGuestWebContentsId: (id: number) => owners.tabByGuest.get(id) ?? null,
    getWorktreeIdForTab: (tab: string) => owners.worktreeByTab.get(tab)
  }
}))

import {
  isRemoteCliDrivenGuest,
  markRemoteCliDrivenWorkspace,
  resetRemoteCliDrivenWorkspacesForTests
} from './remote-cli-driven-workspaces'

afterEach(() => {
  resetRemoteCliDrivenWorkspacesForTests()
  owners.tabByGuest.clear()
  owners.worktreeByTab.clear()
  owners.urlByContents.clear()
})

describe('isRemoteCliDrivenGuest', () => {
  it('covers a driven page and the popups it opened, not other workspaces', () => {
    owners.tabByGuest.set(1, 'host-page')
    owners.tabByGuest.set(2, 'host-page')
    owners.tabByGuest.set(3, 'local-page')
    owners.worktreeByTab.set('host-page', 'repo-host::/srv/app')
    owners.worktreeByTab.set('local-page', 'repo-local::/Users/me/app')
    markRemoteCliDrivenWorkspace('repo-host::/srv/app')

    expect(isRemoteCliDrivenGuest(1)).toBe(true)
    expect(isRemoteCliDrivenGuest(2)).toBe(true)
    expect(isRemoteCliDrivenGuest(3)).toBe(false)
  })

  it('fails closed for a guest whose owning page is unknown once a host drives pages', () => {
    markRemoteCliDrivenWorkspace('repo-host::/srv/app')

    expect(isRemoteCliDrivenGuest(99)).toBe(true)
  })

  it("keeps clipboard read for an unowned extension page, which runs only the extension's code", () => {
    owners.urlByContents.set(7, `chrome-extension://${'a'.repeat(32)}/offscreen.html`)
    owners.urlByContents.set(8, 'https://example.com/')
    markRemoteCliDrivenWorkspace('repo-host::/srv/app')

    expect(isRemoteCliDrivenGuest(7)).toBe(false)
    expect(isRemoteCliDrivenGuest(8)).toBe(true)
  })
})
