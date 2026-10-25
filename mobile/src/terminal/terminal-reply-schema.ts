import { z } from 'zod'
import { salvagedOptional } from '../../../src/shared/zod-salvage'

// Only send.accepted === true proves delivery; malformed/missing envelopes must retain the writers’ not-delivered verdict.
export const terminalSendAcceptedSchema = z
  .looseObject({
    send: salvagedOptional(
      'send',
      z.looseObject({ accepted: salvagedOptional('accepted', z.boolean()) })
    )
  })
  .transform((reply) => reply.send?.accepted === true)

// Booleanize only exact true so malformed fields fall through to legacy resubscribe; unread seq stays unconstrained.
export const terminalViewportUpdatedSchema = z
  .looseObject({
    updated: salvagedOptional('updated', z.boolean()),
    applied: salvagedOptional('applied', z.boolean())
  })
  .transform((reply) => ({ updated: reply.updated === true, applied: reply.applied === true }))

export const terminalAutoRestoreFitSchema = z.looseObject({ ms: z.number().nullable() })

// Payloads are unread; requiring changed/clear fields would reject hosts without affecting any consumer.
export const terminalWriteUnreadReplySchema = z.unknown()
