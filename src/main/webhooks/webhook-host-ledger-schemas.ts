import { z } from 'zod'
import {
  WEBHOOK_CALL_ID_PATTERN,
  WEBHOOK_CALL_STATES,
  WEBHOOK_HOOK_ID_PATTERN
} from '../../shared/connector-webhook-contract'
import { lazyZodSchema } from '../../shared/schema/lazy-zod-schema'

const HookId = lazyZodSchema(() => z.string().regex(WEBHOOK_HOOK_ID_PATTERN))
const Epoch = lazyZodSchema(() => z.number().int().nonnegative())

// received: taken and acknowledged, not yet offered to the automation.
const LedgerCallState = lazyZodSchema(() => z.enum(['received', ...WEBHOOK_CALL_STATES]))
export type LedgerCallState = z.infer<typeof LedgerCallState>

const LedgerCall = lazyZodSchema(() =>
  z.object({
    callId: z.string().regex(WEBHOOK_CALL_ID_PATTERN),
    hookId: HookId,
    automationId: z.string().min(1),
    triggerId: z.string().min(1),
    occurredAt: z.number(),
    subject: z.string().optional(),
    epoch: Epoch,
    sample: z.literal(true).optional(),
    /** The hook's first call that wasn't a sample. */
    first: z.literal(true).optional(),
    /** A host-level hook's call, bound to the automation and rule it was routed to. */
    routed: z.literal(true).optional(),
    /** The id its run will have, bound before the cloud is asked to start it, so every ask names one run. */
    reservedRunId: z.string().optional(),
    /** The call's file, written once its run was cleared to start; it goes with the row. */
    file: z.string().optional(),
    state: LedgerCallState,
    runId: z.string().optional(),
    reason: z.string().optional(),
    /** waiting_capacity: when the run caps have room again. */
    retryAt: z.number().optional(),
    updatedAt: z.number()
  })
)
export type LedgerCall = z.infer<typeof LedgerCall>

export const LedgerHook = lazyZodSchema(() =>
  z.object({
    hookId: HookId,
    automationId: z.string().min(1),
    botId: z.string().min(1),
    /** The newest generation this host has seen; a delivery below it is refused. */
    epoch: Epoch,
    /** What the cloud last confirmed. */
    state: z.enum(['pending', 'live', 'paused']),
    /** A call that wasn't a sample has arrived. */
    called: z.literal(true).optional(),
    /** A pause, resume or delete the cloud hasn't confirmed; retried with its operationId until it does. */
    change: z
      .object({ state: z.enum(['live', 'paused', 'deleted']), operationId: z.string().min(1) })
      .optional()
  })
)
export type LedgerHook = z.infer<typeof LedgerHook>

// A create that may have minted a hook before its automation was saved.
const LedgerIntent = lazyZodSchema(() =>
  z.object({
    operationId: z.string().min(1),
    automationId: z.string().min(1),
    botId: z.string().min(1),
    hookId: HookId.optional(),
    createdAt: z.number()
  })
)
export type LedgerIntent = z.infer<typeof LedgerIntent>

export const StoredLedger = lazyZodSchema(() =>
  z.object({
    account: z.string().min(1),
    hooks: z.array(LedgerHook),
    calls: z.array(LedgerCall),
    intents: z.array(LedgerIntent)
  })
)
export type StoredLedger = z.infer<typeof StoredLedger>
