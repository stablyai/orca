import { afterEach, describe, expect, it, vi } from 'vitest'

const owners = vi.hoisted(() => ({
  tabByGuest: new Map<number, string>(),
  worktreeByTab: new Map<string, string>()
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
})

describe('isRemoteCliDrivenGuest', () => {
  it('leaves every guest alone until a host drives a workspace', () => {
    expect(isRemoteCliDrivenGuest(1)).toBe(false)
    expect(isRemoteCliDrivenGuest(undefined)).toBe(false)
  })

  it('covers a driven page and the popups it opened, not other workspaces', () => {
    owners.tabByGuest.set(1, 'host-page')
    // A popup resolves to the page that opened it.
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
})
