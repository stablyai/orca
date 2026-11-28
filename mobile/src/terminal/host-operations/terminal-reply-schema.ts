import * as z from 'zod'
import { salvagedOptional } from '../../../../src/shared/validation/zod-salvage'

export const terminalComposerDraftSchema = z.looseObject({
  terminal: salvagedOptional(
    'terminal',
    z.looseObject({ draft: salvagedOptional('draft', z.string()) })
  )
})

// Only send.accepted === true proves delivery; malformed/missing envelopes must retain the writers’ not-delivered verdict.
export const terminalSendAcceptedSchema = z
  .looseObject({
    send: salvagedOptional(
      'send',
      z.looseObject({ accepted: salvagedOptional('accepted', z.boolean()) })
    )
  })
  .transform((reply) => reply.send?.accepted === true)

export const terminalInputSessionSchema = z
  .object({ inputSessionId: z.string().min(1).max(128).nullable() })
  .transform((reply) => reply.inputSessionId)

// Booleanize only exact true so malformed fields fall through to legacy resubscribe; unread seq stays unconstrained.
export const terminalViewportUpdatedSchema = z
  .looseObject({
    updated: salvagedOptional('updated', z.boolean()),
    applied: salvagedOptional('applied', z.boolean())
  })
  .transform((reply) => ({ updated: reply.updated === true, applied: reply.applied === true }))

export const terminalAutoRestoreFitSchema = z.looseObject({ ms: z.number().nullable() })

export const terminalBufferClearedSchema = z
  .looseObject({ clear: z.looseObject({ cleared: z.boolean() }) })
  .transform((reply) => reply.clear.cleared)

// Only the host's own observation counts; anything unreadable is left for the probe to call unverifiable.
export const terminalProcessInspectionSchema = z
  .looseObject({
    process: z.looseObject({
      foregroundProcess: z.string().nullable(),
      hasChildProcesses: z.boolean(),
      childProcessEvidence: salvagedOptional(
        'childProcessEvidence',
        z.enum(['children', 'no-children', 'unverifiable'])
      )
    })
  })
  .transform((reply) => reply.process)
