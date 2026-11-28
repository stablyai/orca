import { expect, it } from 'vitest'
import { markRpcDeliveryUnknown } from '../../transport/rpc/rpc-delivery-ambiguity'
import {
  NotificationReplyFailure,
  notificationReplyFailureReason
} from './notification-reply-failure-reason'

it('preserves uncertainty after a written request loses its reply', () => {
  expect(
    notificationReplyFailureReason(
      markRpcDeliveryUnknown(new Error('connection lost after group/item write'))
    )
  ).toBe('unconfirmed')
  expect(notificationReplyFailureReason(new NotificationReplyFailure('refused'))).toBe('refused')
  expect(notificationReplyFailureReason(new Error('connection unavailable before write'))).toBe(
    'unreachable'
  )
})
