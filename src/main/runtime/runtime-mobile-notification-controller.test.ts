import { describe, expect, it } from 'vitest'
import {
  RuntimeMobileNotificationController,
  type MobileNotificationEvent
} from './runtime-mobile-notification-controller'

function notification(worktreeId: string | undefined): MobileNotificationEvent {
  return {
    type: 'notification',
    source: 'agent-task-complete',
    title: 'Secret: done',
    body: '',
    ...(worktreeId ? { worktreeId } : {})
  }
}

describe('RuntimeMobileNotificationController incognito gate', () => {
  it('never pushes, replays or records a workspace hidden from phones', () => {
    const controller = new RuntimeMobileNotificationController({
      isWorktreeHiddenFromPhones: (worktreeId) => worktreeId.startsWith('secret::')
    })
    const delivered: MobileNotificationEvent[] = []
    controller.onDispatched((event) => delivered.push(event))

    controller.dispatch(notification('secret::/repo/secret'))
    controller.dispatch(notification('open::/repo/open'))
    controller.dispatch(notification(undefined))

    expect(
      delivered.map((event) => (event.type === 'notification' ? event.worktreeId : null))
    ).toEqual(['open::/repo/open', undefined])
    expect(
      controller
        .getMissedSince(0, controller.getEpoch())
        .some((event) => event.type === 'notification' && event.worktreeId?.startsWith('secret'))
    ).toBe(false)
  })

  it('stops replaying a workspace that became hidden after it was recorded', () => {
    const hidden = new Set<string>()
    const controller = new RuntimeMobileNotificationController({
      isWorktreeHiddenFromPhones: (worktreeId) => hidden.has(worktreeId)
    })
    controller.dispatch(notification('secret::/repo/secret'))
    controller.dispatch(notification('open::/repo/open'))
    hidden.add('secret::/repo/secret')

    expect(
      controller
        .getMissedSince(0, controller.getEpoch())
        .map((event) => (event.type === 'notification' ? event.worktreeId : null))
    ).toEqual(['open::/repo/open'])
  })

  it('still delivers dismissals, which name no workspace', () => {
    const controller = new RuntimeMobileNotificationController({
      isWorktreeHiddenFromPhones: () => true
    })
    const delivered: MobileNotificationEvent[] = []
    controller.onDispatched((event) => delivered.push(event))

    controller.dismiss('n-1')

    expect(delivered).toHaveLength(1)
  })
})
