import { beforeEach, expect, it, vi } from 'vitest'
import { AppState } from 'react-native'
import {
  notificationViewingOfRoute,
  sessionOfPageLocation,
  setHostDocumentSession,
  setNotificationViewingWorkspace,
  shouldSuppressNotificationWhileViewing
} from './notification-viewing-policy'

vi.mock('react-native', () => ({ AppState: { currentState: 'background' } }))
beforeEach(() => {
  setNotificationViewingWorkspace(null)
  AppState.currentState = 'background'
})

it('suppresses only the workspace being viewed on this phone, and never while backgrounded', async () => {
  const event = { source: 'terminal-bell', worktreeId: 'folder-id' }
  setNotificationViewingWorkspace({ hostId: 'ssh-host', worktreeId: 'folder-id' })
  AppState.currentState = 'active'
  expect(await shouldSuppressNotificationWhileViewing(event, 'ssh-host', true)).toBe(true)
  expect(await shouldSuppressNotificationWhileViewing(event, 'another-host', true)).toBe(false)
  expect(
    await shouldSuppressNotificationWhileViewing(
      { ...event, worktreeId: 'other' },
      'ssh-host',
      true
    )
  ).toBe(false)
  AppState.currentState = 'background'
  expect(await shouldSuppressNotificationWhileViewing(event, 'ssh-host', true)).toBe(false)
})

it('suppresses the session a host list document shows inside itself, until its page moves on', () => {
  // Jump back in and notification taps open the session in the host route's document, so the native route stays /h/<host>.
  const event = { source: 'terminal-bell', worktreeId: 'repo::/work' }
  setNotificationViewingWorkspace(notificationViewingOfRoute('/h/host-1', { hostId: 'host-1' }))
  AppState.currentState = 'active'
  setHostDocumentSession('host-1', sessionOfPageLocation('/h/host-1/session/repo%3A%3A%2Fwork'))
  expect(shouldSuppressNotificationWhileViewing(event, 'host-1', true)).toBe(true)
  setHostDocumentSession('host-1', sessionOfPageLocation('/h/host-1'))
  expect(shouldSuppressNotificationWhileViewing(event, 'host-1', true)).toBe(false)
})
