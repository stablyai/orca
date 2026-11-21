import { expect, it, vi } from 'vitest'
import { createRetainedAgentAttentionReceiver } from './notification-delivery-service'

const notice = (id: string) => ({
  notificationId: id,
  title: 'Claude',
  body: 'May have missed mail.'
})

it('a missed-mail alert main delivers asks for the custom sound only once it is shown', async () => {
  const onDelivered = vi.fn()
  const receive = createRetainedAgentAttentionReceiver({
    dispatch: async (request) => ({
      delivered: request.notificationId === 'shown',
      ...(request.notificationId === 'shown' ? {} : { reason: 'disabled' as const })
    }),
    dismiss: () => {},
    readWorkspaceSession: () => ({ activeWorktreeId: null, activeWorkspaceExecutionHostId: null }),
    onDelivered
  })
  receive('skipped', notice('skipped'))
  receive('shown', notice('shown'))
  await new Promise((resolve) => setImmediate(resolve))
  expect(onDelivered).toHaveBeenCalledTimes(1)
})
