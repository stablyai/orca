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

// Only an exact boolean answers; a malformed reply leaves the chat's last verdict standing.
export const terminalAgentRunningSchema = z
  .looseObject({ agentStatus: z.looseObject({ isRunningAgent: z.boolean() }) })
  .transform((reply) => reply.agentStatus.isRunningAgent)

const PANE_AGENT_RESTART_REFUSALS = [
  'no_resume',
  'held_elsewhere',
  'pane_unavailable',
  'no_launch_command',
  'failed'
] as const

// An unknown refusal from a newer host reads as a plain failure, not as an incompatible reply.
export const terminalAgentRestartSchema = z
  .looseObject({
    restart: z.looseObject({ ok: z.boolean(), reason: z.string().optional() })
  })
  .transform((reply) =>
    reply.restart.ok
      ? { ok: true as const }
      : {
          ok: false as const,
          reason:
            PANE_AGENT_RESTART_REFUSALS.find((reason) => reason === reply.restart.reason) ??
            'failed'
        }
  )
