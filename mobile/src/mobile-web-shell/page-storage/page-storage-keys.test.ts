import { describe, expect, it } from 'vitest'
import {
  isPageStorageKey,
  isPageStorageKeyForRoute,
  pageRouteWorkspace,
  pageStorageEntriesForInit,
  PAGE_STORAGE_MAX_VALUE_CHARS
} from './page-storage-keys'

const HOST_ROUTE = '/h/host-1'
const SESSION_ROUTE = '/h/host-1/session/wt-1'

describe('the keys a page may read and write', () => {
  it('refuses the rest of the namespace', () => {
    // A broad orca: prefix would let pages rewrite native pairings and push registrations.
    for (const key of [
      'orca:remotePushHostRegistrations',
      'orca:pushServiceNotificationsEnabled',
      'orca:home-snapshot:v1',
      'orca:hosts'
    ]) {
      expect(isPageStorageKey(key), key).toBe(false)
    }
  })

  it('refuses a key that only starts like an allowlisted one', () => {
    expect(isPageStorageKey('orca:last-visited-worktree:other')).toBe(false)
    expect(isPageStorageKey('not-orca:pins:host-1')).toBe(false)
  })
})

describe('the workspace a route names', () => {
  it('reads the session route, decoded as the router decodes it', () => {
    expect(pageRouteWorkspace('/h/host-1/session/wt-1')).toEqual({
      hostId: 'host-1',
      worktreeId: 'wt-1'
    })
    expect(pageRouteWorkspace('/h/host%201/session/folder%3A%2Ftmp%2Fa')).toEqual({
      hostId: 'host 1',
      worktreeId: 'folder:/tmp/a'
    })
  })

  it('answers null for every other shape, so no other route is handed a workspace key', () => {
    for (const pathname of [
      '/h/host-1',
      '/h/host-1/tasks',
      '/h/host-1/files/wt-1',
      '/h/host-1/review/wt-1',
      '/h/host-1/files/preview/wt-1',
      '/h/host-1/session/',
      '/h//session/wt-1',
      'h/host-1/session/wt-1'
    ]) {
      expect(pageRouteWorkspace(pathname), pathname).toBeNull()
    }
  })

  it('answers null for a stray percent rather than throwing inside the init build', () => {
    expect(pageRouteWorkspace('/h/host-1/session/%zz')).toBeNull()
  })
})

describe('the allowlist narrowed to one session', () => {
  it("refuses another host's pinned list, which the shape check alone admits", () => {
    expect(isPageStorageKey('orca:pins:host-2')).toBe(true)
    expect(isPageStorageKeyForRoute('orca:pins:host-2', 'host-1', SESSION_ROUTE)).toBe(false)
  })

  it("refuses another workspace's chat tabs, which the shape check alone admits", () => {
    // Scope workspace keys so a page cannot rewrite its neighbor’s chat tabs.
    expect(isPageStorageKey('orca:nativeChatTabs:host-1:wt-2')).toBe(true)
    expect(
      isPageStorageKeyForRoute('orca:nativeChatTabs:host-1:wt-2', 'host-1', SESSION_ROUTE)
    ).toBe(false)
    expect(
      isPageStorageKeyForRoute('orca:nativeChatTabs:host-1:wt-1', 'host-1', SESSION_ROUTE)
    ).toBe(true)
  })

  it('refuses a workspace key on a route that names no workspace', () => {
    expect(isPageStorageKeyForRoute('orca:nativeChatTabs:host-1:wt-1', 'host-1', HOST_ROUTE)).toBe(
      false
    )
  })
})

describe('what init may carry', () => {
  it('keeps an ordinary value and names the oversized value it drops', () => {
    const held = {
      'orca:terminalTextScale': '1',
      'orca:mobileStructuredSendOperations:v1': 'x'.repeat(PAGE_STORAGE_MAX_VALUE_CHARS + 1)
    }
    const { entries, dropped } = pageStorageEntriesForInit(held)
    expect(Object.keys(entries)).toEqual(['orca:terminalTextScale'])
    expect(dropped).toEqual(['orca:mobileStructuredSendOperations:v1'])
  })

  it('keeps a value of exactly the bound, so the drop above discriminates', () => {
    const at = { 'orca:custom-accessory-keys': 'x'.repeat(PAGE_STORAGE_MAX_VALUE_CHARS) }
    expect(pageStorageEntriesForInit(at)).toEqual({ entries: at, dropped: [], oversize: [] })
  })
})
