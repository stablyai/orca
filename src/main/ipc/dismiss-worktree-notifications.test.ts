import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createAnnouncedNotificationRegistry,
  setSessionAnnouncedNotificationRegistry
} from '../notifications/announced-notification-registry'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { activeNotificationsById } from './native-notification-lifecycle'
import { dismissAnnouncedNotificationsForWorktree } from './dismiss-worktree-notifications'

type ActiveEntry = Parameters<typeof activeNotificationsById.set>[1]

function makeRuntime(): {
  runtime: OrcaRuntimeService
  dismissMobileNotification: ReturnType<typeof vi.fn>
} {
  const dismissMobileNotification = vi.fn()
  return {
    runtime: { dismissMobileNotification } as unknown as OrcaRuntimeService,
    dismissMobileNotification
  }
}

function seedDesktopNotification(id: string): { close: ReturnType<typeof vi.fn> } {
  const close = vi.fn()
  activeNotificationsById.set(id, { notification: { close }, release: () => {} } as ActiveEntry)
  return { close }
}

afterEach(() => {
  activeNotificationsById.clear()
  setSessionAnnouncedNotificationRegistry(null)
})

describe('dismissAnnouncedNotificationsForWorktree', () => {
  it('closes and releases the worktree announcements across panes', () => {
    const registry = createAnnouncedNotificationRegistry()
    setSessionAnnouncedNotificationRegistry(registry)
    registry.record('pane-a', 'id-1', undefined, 'repo::/w')
    registry.record('pane-b', 'id-2', undefined, 'repo::/w')
    registry.record('pane-b', 'id-3', undefined, 'repo::/other')
    const first = seedDesktopNotification('id-1')
    const second = seedDesktopNotification('id-2')

    const dismissed = dismissAnnouncedNotificationsForWorktree('repo::/w', makeRuntime().runtime)

    expect(dismissed).toBe(2)
    expect(first.close).toHaveBeenCalledOnce()
    expect(second.close).toHaveBeenCalledOnce()
    // The other worktree's announcement survives for its own acknowledgement.
    expect(registry.take('pane-b').map((entry) => entry.id)).toEqual(['id-3'])
  })

  it('dismisses the phone copy of announcements without a journal origin', () => {
    const registry = createAnnouncedNotificationRegistry()
    setSessionAnnouncedNotificationRegistry(registry)
    registry.record('pane-a', 'id-generic', undefined, 'repo::/w')
    const { runtime, dismissMobileNotification } = makeRuntime()

    dismissAnnouncedNotificationsForWorktree('repo::/w', runtime)

    expect(dismissMobileNotification).toHaveBeenCalledWith('id-generic')
  })

  it('is a no-op when no renderer session registered a registry yet', () => {
    expect(dismissAnnouncedNotificationsForWorktree('repo::/w', makeRuntime().runtime)).toBe(0)
  })
})
