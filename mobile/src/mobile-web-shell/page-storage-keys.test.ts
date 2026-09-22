import { describe, expect, it } from 'vitest'
import {
  isPageStorageKey,
  isPageStorageKeyForRoute,
  pageRouteWorkspace,
  pageStorageEntriesForInit,
  pageStorageKeysForRoute,
  PAGE_STORAGE_EXACT_KEYS,
  PAGE_STORAGE_MAX_ENTRIES,
  PAGE_STORAGE_MAX_KEY_CHARS,
  PAGE_STORAGE_MAX_VALUE_CHARS
} from './page-storage-keys'

const HOST_ROUTE = '/h/host-1'
const SESSION_ROUTE = '/h/host-1/session/wt-1'

describe('the keys a page may read and write', () => {
  it('takes the ones the list keeps', () => {
    expect(isPageStorageKey('orca:last-visited-worktree')).toBe(true)
    expect(isPageStorageKey('orca:pins:host-1')).toBe(true)
    expect(isPageStorageKey('orca:terminalTextScale')).toBe(true)
    expect(isPageStorageKey('orca:nativeChatTabs:host-1:wt-1')).toBe(true)
  })

  it('refuses the rest of the namespace, including the flag that turns this on', () => {
    // Everything the app stores lives under `orca:`, so a page that could write any of it could
    // turn the hybrid shell on for a build that never offered it.
    for (const key of [
      'orca:mobileWebShellEnabled',
      'orca:remotePushHostRegistrations',
      'orca:pushServiceNotificationsEnabled',
      'orca:home-snapshot:v1',
      'orca:hosts'
    ]) {
      expect(isPageStorageKey(key), key).toBe(false)
    }
  })

  it('refuses the bare prefix, which names no host', () => {
    expect(isPageStorageKey('orca:pins:')).toBe(false)
    expect(isPageStorageKey('orca:nativeChatTabs:')).toBe(false)
  })

  it('refuses a key that only starts like an allowlisted one', () => {
    expect(isPageStorageKey('orca:last-visited-worktree:other')).toBe(false)
    expect(isPageStorageKey('not-orca:pins:host-1')).toBe(false)
  })

  it('refuses a key past the cap, whatever it starts with', () => {
    expect(isPageStorageKey(`orca:pins:${'h'.repeat(PAGE_STORAGE_MAX_KEY_CHARS)}`)).toBe(false)
  })

  it('names what the shell reads out of the app store for a route with no workspace', () => {
    const keys = pageStorageKeysForRoute('host-1', HOST_ROUTE)
    expect(keys).toEqual([...PAGE_STORAGE_EXACT_KEYS, 'orca:pins:host-1'])
    for (const key of keys) {
      expect(isPageStorageKey(key), key).toBe(true)
    }
  })

  it("adds the session route's two workspace-scoped keys, and only for it", () => {
    const session = pageStorageKeysForRoute('host-1', SESSION_ROUTE)
    expect(
      session.filter((key) => !pageStorageKeysForRoute('host-1', HOST_ROUTE).includes(key))
    ).toEqual(['orca:nativeChatTabs:host-1:wt-1', 'orca:terminalLiveInputDisabled:host-1:wt-1'])
    // A route that carries a worktree segment and declares no key of its own gets none.
    expect(pageStorageKeysForRoute('host-1', '/h/host-1/files/wt-1')).toEqual(
      pageStorageKeysForRoute('host-1', HOST_ROUTE)
    )
  })

  it('stays inside the entry count init is allowed to carry', () => {
    // The handed list is what `init` is built from, and its schema refines on this number: a list
    // that outgrew it would take the whole frame down rather than one key.
    expect(pageStorageKeysForRoute('host-1', SESSION_ROUTE).length).toBeLessThanOrEqual(
      PAGE_STORAGE_MAX_ENTRIES
    )
  })

  it('drops a workspace key whose id pushes it past the key cap, rather than handing one over', () => {
    const long = 'w'.repeat(PAGE_STORAGE_MAX_KEY_CHARS)
    const keys = pageStorageKeysForRoute('host-1', `/h/host-1/session/${long}`)
    // Every key `init` carries is one the page's own schema will take; without the filter the two
    // long ones are in this list and the page refuses the frame.
    expect(keys.filter((key) => !isPageStorageKey(key))).toEqual([])
    expect(keys).toEqual(pageStorageKeysForRoute('host-1', HOST_ROUTE))
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
    // `decodeURIComponent('%zz')` throws, and this runs while the shell is building `init`.
    expect(pageRouteWorkspace('/h/host-1/session/%zz')).toBeNull()
  })
})

describe('the allowlist narrowed to one session', () => {
  it('admits exactly the keys that session was handed', () => {
    for (const key of pageStorageKeysForRoute('host-1', SESSION_ROUTE)) {
      expect(isPageStorageKeyForRoute(key, 'host-1', SESSION_ROUTE), key).toBe(true)
    }
  })

  it("refuses another host's pinned list, which the shape check alone admits", () => {
    expect(isPageStorageKey('orca:pins:host-2')).toBe(true)
    expect(isPageStorageKeyForRoute('orca:pins:host-2', 'host-1', SESSION_ROUTE)).toBe(false)
  })

  it("refuses another workspace's chat tabs, which the shape check alone admits", () => {
    // One level in from the host rule above, and the reason the route is threaded at all: a page
    // opened on one workspace must not rewrite the chat tabs of the one beside it.
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
  it('keeps a value at the bound and drops the one above it, naming what it dropped', () => {
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

  it('never carries more entries than the schema admits', () => {
    const held = Object.fromEntries(
      Array.from({ length: PAGE_STORAGE_MAX_ENTRIES + 4 }, (_, index) => [`k${String(index)}`, 'v'])
    )
    const { entries, dropped, oversize } = pageStorageEntriesForInit(held)
    expect(Object.keys(entries)).toHaveLength(PAGE_STORAGE_MAX_ENTRIES)
    expect(dropped).toHaveLength(4)
    // Room, not size: the page may write any of these four itself, so none is refused (33.6).
    expect(oversize).toEqual([])
  })
})
