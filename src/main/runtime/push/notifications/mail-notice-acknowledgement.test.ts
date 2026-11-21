import { expect, it, vi } from 'vitest'
import { RuntimeMobileNotificationController } from './runtime-mobile-notification-controller'

const notice = (body: string) => ({
  type: 'notification' as const,
  source: 'agent-task-complete' as const,
  title: 'Claude in COORD may have missed mail',
  body
})

it('dismissing a mail notice stops it replaying until its mail changes', () => {
  const attention = vi.fn()
  const controller = new RuntimeMobileNotificationController(attention)
  const id = 'orchestration-mail:pty-1'
  controller.reconcileMailboxAttention(id, notice('Ask Claude to run orca orchestration check.'))
  expect(controller.getRetainedAgentAttention().map((n) => n.notificationId)).toEqual([id])

  controller.dismiss(id)
  expect(controller.getRetainedAgentAttention()).toEqual([])
  expect(attention).toHaveBeenLastCalledWith(id, null)
  controller.reconcileMailboxAttention(id, notice('Ask Claude to run orca orchestration check.'))
  expect(controller.getRetainedAgentAttention()).toEqual([])
  expect(controller.getMissedSince(0).filter((event) => event.type === 'notification')).toEqual([])

  controller.reconcileMailboxAttention(
    id,
    notice('Ask Claude to run orca orchestration check --run run_2.')
  )
  expect(controller.getRetainedAgentAttention().map((n) => n.notificationId)).toEqual([id])
})

it('a muted mail notice stays muted in the live change and the reconnect snapshot', () => {
  const attention = vi.fn()
  const controller = new RuntimeMobileNotificationController(attention)
  const id = 'orchestration-mail:pty-1'
  controller.reconcileMailboxAttention(id, { ...notice('Ask Claude.'), desktopAllowed: false })
  expect(attention).toHaveBeenLastCalledWith(id, expect.objectContaining({ desktopAllowed: false }))
  expect(controller.getRetainedAgentAttention()).toEqual([
    expect.objectContaining({ notificationId: id, desktopAllowed: false })
  ])
})
