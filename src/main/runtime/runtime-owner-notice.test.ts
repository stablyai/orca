import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RuntimeMobileNotificationController,
  type MobileNotificationEvent,
  type OwnerNotice
} from './push/notifications/runtime-mobile-notification-controller'
import { setRuntimeDesktopSurface } from './construction/runtime-desktop-surface'

const notice: OwnerNotice = {
  id: 'bot-could-not-finish:bot-1:Morning digest',
  title: "Reviewer couldn't finish",
  body: `"Morning digest" couldn't start.`,
  worktreeId: 'folder:fw-1',
  paneKey: 'pane-1'
}

function controller() {
  const banners: { title: string; body: string }[] = []
  setRuntimeDesktopSurface({
    showNotification: (input) => banners.push(input) > 0,
    findWindowById: () => null,
    onIpc: () => {},
    removeIpcListener: () => {}
  })
  const notifications = new RuntimeMobileNotificationController()
  const sent: MobileNotificationEvent[] = []
  notifications.onDispatched((event) => sent.push(event))
  return { notifications, banners, sent }
}

afterEach(() => setRuntimeDesktopSurface(null))

describe('owner notices', () => {
  it('shows a banner and sends phones a plugin notice, with no agent state', () => {
    const { notifications, banners, sent } = controller()

    notifications.dispatchOwnerNotice(notice, { enabled: true })

    expect(banners).toEqual([{ title: notice.title, body: notice.body }])
    expect(sent).toEqual([
      expect.objectContaining({
        type: 'notification',
        source: 'plugin',
        title: notice.title,
        body: notice.body,
        worktreeId: 'folder:fw-1',
        paneKey: 'pane-1',
        notificationId: notice.id,
        attentionKey: notice.id
      })
    ])
    expect(sent[0]).not.toHaveProperty('agentState')
  })

  it('shows only the banner when the phone already heard it', () => {
    const { notifications, banners, sent } = controller()

    notifications.dispatchOwnerNotice({ ...notice, phone: false }, { enabled: true })

    expect(banners).toHaveLength(1)
    expect(sent).toEqual([])
  })

  it('sends only the phone notice when the windows already show it', () => {
    const { notifications, banners, sent } = controller()

    notifications.dispatchOwnerNotice({ ...notice, desktop: false }, { enabled: true })

    expect(banners).toEqual([])
    expect(sent).toHaveLength(1)
  })

  it('says nothing while notifications are off', () => {
    const { notifications, banners, sent } = controller()

    notifications.dispatchOwnerNotice(notice, { enabled: false })

    expect(banners).toEqual([])
    expect(sent).toEqual([])
  })

  it('tells the same notice once per cooldown, and a different one at once', () => {
    vi.useFakeTimers()
    const { notifications, sent } = controller()

    notifications.dispatchOwnerNotice(notice, { enabled: true })
    notifications.dispatchOwnerNotice(notice, { enabled: true })
    notifications.dispatchOwnerNotice({ ...notice, id: 'other' }, { enabled: true })

    expect(sent.map((event) => event.type === 'notification' && event.notificationId)).toEqual([
      notice.id,
      'other'
    ])
    vi.useRealTimers()
  })
})
