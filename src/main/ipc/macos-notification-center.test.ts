import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NotificationDispatchRequest } from '../../shared/notification-settings-types'
import { macosNotificationIdentity } from './macos-notification-center'

vi.mock('electron', () => ({ Notification: {} }))

const realPlatform = process.platform

function asDarwin(): void {
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
}

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
})

describe('macosNotificationIdentity', () => {
  it('groups unpositioned pane announcements by pane', () => {
    asDarwin()
    const request = { paneKey: 'tab-1:leaf-2' } as NotificationDispatchRequest
    expect(macosNotificationIdentity(request)).toEqual({ groupId: 'pane:tab-1:leaf-2' })
  })

  it('keeps once-only ids for structured alerts, pane-less ones included', () => {
    asDarwin()
    const request = {
      structuredOrigin: { kind: 'completion' },
      notificationId: 'id-1'
    } as unknown as NotificationDispatchRequest
    expect(macosNotificationIdentity(request)).toEqual({ id: 'id-1' })
  })

  it('groups pane-less worktree announcements under the synthetic subject removal uses', () => {
    asDarwin()
    const request = { worktreeId: 'repo::/w' } as NotificationDispatchRequest
    expect(macosNotificationIdentity(request)).toEqual({
      groupId: 'pane:worktree:repo::/w'
    })
  })

  it('gives global announcements no identity and stays inert off darwin', () => {
    asDarwin()
    expect(macosNotificationIdentity({} as NotificationDispatchRequest)).toEqual({})
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    expect(
      macosNotificationIdentity({ paneKey: 'tab-1:leaf-2' } as NotificationDispatchRequest)
    ).toEqual({})
  })
})
