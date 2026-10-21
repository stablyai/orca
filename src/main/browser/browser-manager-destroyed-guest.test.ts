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
vi.mock('./popup-origin-bar-window', () => ({ openPopupWithOriginBar: vi.fn() }))

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

  it('releases registered callbacks and ownership after 1000 distinct guest destructions', () => {
    for (let index = 0; index < 1000; index++) {
      register(`retired-${index}`).destroy()
    }
    expectRetainedCount(0)
  })

  it('leaves no dead-guest callbacks for the window-close unregisterAll path', () => {
    for (let index = 0; index < 1000; index++) {
      register(`window-${index}`).destroy()
    }
    manager.unregisterAll()
    expectRetainedCount(0)
  })

  it('keeps explicit unregister before destruction idempotent', () => {
    const guest = register('explicit')
    manager.unregisterGuest('explicit')
    guest.destroy()
    manager.unregisterGuest('explicit')
    expectRetainedCount(0)
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

  it('cleans a popup without retiring its live primary page', () => {
    const parent = register('popup-parent')
    const popup = createGuest()
    manager.attachGuestPolicies(popup.asWebContents(), {
      rootGuestWebContentsId: parent.id,
      browserTabId: 'popup-parent'
    })
    popup.destroy()
    expect(manager.getGuestWebContentsId('popup-parent')).toBe(parent.id)
    expectRetainedCount(1)
  })

  it('cleans policies for a guest destroyed before registration', () => {
    const guest = createGuest()
    manager.attachGuestPolicies(guest.asWebContents())
    guest.destroy()
    expectRetainedCount(0)
  })

  it('preserves live guest ownership when its renderer process needs reload recovery', () => {
    const guest = register('renderer-recovery')
    guest.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 })
    expect(manager.getGuestWebContentsId('renderer-recovery')).toBe(guest.id)
    expect(manager.getSessionProfileIdForTab('renderer-recovery')).toBe('profile-1')
    expectRetainedCount(1)
  })

  it('rebuilds ownership when a restored page registers its fresh guest', () => {
    register('fresh-owner').destroy()
    const replacement = register('fresh-owner')
    expect(manager.getGuestWebContentsId('fresh-owner')).toBe(replacement.id)
    expect(manager.getWorktreeIdForTab('fresh-owner')).toBe('worktree-1')
    expect(manager.getSessionProfileIdForTab('fresh-owner')).toBe('profile-1')
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
