import * as z from 'zod'
import type { BotGroupStore } from './bot-group-store'

// Both kinds of remote work share the group's existing transactional pending-send journal.
const DELIVERY = 'remote-delivery:'
const ROOM_MAIL = 'remote-room-mail:'
const Delivery = z.object({ messageId: z.string(), body: z.string(), isAnswer: z.boolean() })
const RoomMail = z.object({ requestId: z.string(), isPost: z.boolean() })
export type PendingGroupRemoteDelivery = z.infer<typeof Delivery> & { id: string }

export class BotGroupRouteQueue {
  constructor(private readonly store: BotGroupStore) {}

  stageMailRoute(mailId: string, groupId: string, requestId: string, isPost: boolean): void {
    this.store.stagePending(`${ROOM_MAIL}${mailId}`, groupId, JSON.stringify({ requestId, isPost }))
  }

  pendingMailRoutes(groupId: string) {
    return this.store.pendingRows(groupId, ROOM_MAIL).map(({ id, context }) => ({
      mailId: id.slice(ROOM_MAIL.length),
      ...RoomMail.parse(JSON.parse(context))
    }))
  }

  routedMail(mailId: string): void {
    this.store.delivered([`${ROOM_MAIL}${mailId}`])
  }

  queueRemoteDelivery(
    id: string,
    groupId: string,
    messageId: string,
    body: string,
    isAnswer = false
  ): void {
    this.store.stagePending(
      `${DELIVERY}${id}`,
      groupId,
      JSON.stringify({ messageId, body, isAnswer })
    )
  }

  pendingRemoteDeliveries(groupId?: string, messageId?: string): PendingGroupRemoteDelivery[] {
    return this.store.pendingRows(groupId, DELIVERY).flatMap(({ id, context }) => {
      const delivery = Delivery.parse(JSON.parse(context))
      return messageId === undefined || messageId === delivery.messageId
        ? [{ id: id.slice(DELIVERY.length), ...delivery }]
        : []
    })
  }

  claimRemoteDelivery(id: string): boolean {
    return this.store.delivered([`${DELIVERY}${id}`]) > 0
  }
}
