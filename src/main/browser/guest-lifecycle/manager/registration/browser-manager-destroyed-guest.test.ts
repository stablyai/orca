import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ guests: new Map<number, Electron.WebContents>() }))
vi.mock('electron', () => ({
  app: { getPath: () => '/downloads' },
  BrowserWindow: { fromWebContents: () => null },
  clipboard: { writeText: vi.fn() },
  shell: { openExternal: vi.fn() },
  Menu: { buildFromTemplate: vi.fn() },
  screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }) },
  webContents: { fromId: (id: number) => mocks.guests.get(id) ?? null }
}))
vi.mock('../../popups/presentation/popup-origin-bar-window', () => ({
  openPopupWithOriginBar: vi.fn()
}))

import {
  DestroyedGuestTestContents,
  DestroyedGuestTestManager
} from './browser-manager-destroyed-guest-test-fixture'

describe('browser guest destruction ownership', () => {
  const manager = new DestroyedGuestTestManager()
  const pageIds = new Set<string>()
  const guests = new Set<DestroyedGuestTestContents>()
  let nextId = 1

  function createGuest(): DestroyedGuestTestContents {
    const guest = new DestroyedGuestTestContents(nextId++)
    guests.add(guest)
    mocks.guests.set(guest.id, guest.asWebContents())
    return guest
  }

  function register(pageId: string): DestroyedGuestTestContents {
    const guest = createGuest()
    pageIds.add(pageId)
    manager.attachGuestPolicies(guest.asWebContents())
    expect(
      manager.registerGuest({
        browserPageId: pageId,
        webContentsId: guest.id,
        rendererWebContentsId: 5001,
        workspaceId: 'workspace-1',
        worktreeId: 'worktree-1',
        sessionProfileId: 'profile-1'
      })
    ).toBe(true)
    return guest
  }

  function expectRetainedCount(count: number): void {
    const counts = manager.retainedCounts()
    expect(counts).toEqual(Object.fromEntries(Object.keys(counts).map((key) => [key, count])))
  }

  afterEach(() => {
    for (const pageId of pageIds) {
      manager.unregisterGuest(pageId)
    }
    manager.unregisterAll()
    for (const guest of guests) {
      guest.removeAllListeners()
    }
    pageIds.clear()
    guests.clear()
    mocks.guests.clear()
  })

  it('does not let a captured old destroyed callback retire a replacement guest', () => {
    const old = register('replacement')
    const [oldDestroyed] = old.listeners('destroyed')
    expect(oldDestroyed).toBeTypeOf('function')
    const replacement = register('replacement')
    oldDestroyed.call(old)
    expect(manager.getGuestWebContentsId('replacement')).toBe(replacement.id)
    expect(manager.getWorktreeIdForTab('replacement')).toBe('worktree-1')
    expectRetainedCount(1)
  })

  it('preserves a sibling page using the same browser session profile', () => {
    const retiring = register('retiring')
    const sibling = register('sibling')
    expect(retiring.session).toBe(sibling.session)
    retiring.destroy()
    expect(manager.getGuestWebContentsId('sibling')).toBe(sibling.id)
    expect(manager.getSessionProfileIdForTab('sibling')).toBe('profile-1')
    expect(manager.getWorktreeIdForTab('sibling')).toBe('worktree-1')
    expectRetainedCount(1)
  })
})
