import { describe, expect, it } from 'vitest'
import { ROOM_QUEUE_METHODS } from './rooms-queue'

const MESSAGE_ID = '00000000-0000-4000-8000-000000000001'
const PARTICIPANT_ID = '00000000-0000-4000-8000-000000000002'
const DELIVERY_ID = '00000000-0000-4000-8000-000000000003'
const OTHER_DELIVERY_ID = '00000000-0000-4000-8000-000000000004'

describe('rooms queue RPC', () => {
  it('accepts full retarget and exact target removal as distinct operations', () => {
    const schema = ROOM_QUEUE_METHODS.find(
      (method) => method.name === 'rooms.messages.retarget'
    )!.params!

    expect(
      schema.safeParse({ messageId: MESSAGE_ID, participantIds: [PARTICIPANT_ID] }).success
    ).toBe(true)
    expect(
      schema.safeParse({ messageId: MESSAGE_ID, removeParticipantId: PARTICIPANT_ID }).success
    ).toBe(true)
    expect(
      schema.safeParse({
        messageId: MESSAGE_ID,
        participantIds: [],
        removeParticipantId: PARTICIPANT_ID
      }).success
    ).toBe(false)
  })

  it('keeps agent reorder markers mutually exclusive', () => {
    const schema = ROOM_QUEUE_METHODS.find(
      (method) => method.name === 'rooms.deliveries.reorder'
    )!.params!
    const base = { participantId: PARTICIPANT_ID, deliveryIds: [DELIVERY_ID, OTHER_DELIVERY_ID] }

    expect(schema.safeParse(base).success).toBe(true)
    expect(schema.safeParse({ ...base, movedDeliveryId: DELIVERY_ID }).success).toBe(true)
    expect(schema.safeParse({ ...base, retargetMessageId: MESSAGE_ID }).success).toBe(true)
    expect(
      schema.safeParse({
        ...base,
        movedDeliveryId: DELIVERY_ID,
        retargetMessageId: MESSAGE_ID
      }).success
    ).toBe(false)
  })

  it('accepts only legacy or explicitly marked shared queue reorder', () => {
    const schema = ROOM_QUEUE_METHODS.find(
      (method) => method.name === 'rooms.messages.reorderQueue'
    )!.params!
    const base = { roomId: PARTICIPANT_ID, messageIds: [MESSAGE_ID] }

    expect(schema.safeParse(base).success).toBe(true)
    expect(schema.safeParse({ ...base, movedMessageId: MESSAGE_ID }).success).toBe(true)
    expect(schema.safeParse({ ...base, retargetMessageId: MESSAGE_ID }).success).toBe(true)
    expect(
      schema.safeParse({
        ...base,
        movedMessageId: MESSAGE_ID,
        retargetMessageId: MESSAGE_ID
      }).success
    ).toBe(false)
    expect(schema.safeParse({ ...base, movedDeliveryId: DELIVERY_ID }).success).toBe(false)
  })

  it('distinguishes legacy delivery Steer from explicit group Steer', () => {
    const schema = ROOM_QUEUE_METHODS.find(
      (method) => method.name === 'rooms.deliveries.steer'
    )!.params!

    expect(schema.safeParse({ deliveryId: DELIVERY_ID }).success).toBe(true)
    expect(schema.safeParse({ deliveryId: DELIVERY_ID, group: true }).success).toBe(true)
    expect(schema.safeParse({ deliveryId: DELIVERY_ID, group: false }).success).toBe(false)
  })
})
