import { z } from 'zod'
import {
  isAgentSessionProviderHandleLink,
  type AgentSessionProviderHandleLink
} from '../../../shared/agent-session/lifecycle/agent-session-provider-handle'

const id = z.string().min(1)
const time = z.number().finite().nonnegative()
const cursor = z.object({ epoch: id, sequence: z.number().int().nonnegative() }).strict()
const link = z.custom<AgentSessionProviderHandleLink>(isAgentSessionProviderHandleLink)
export const contextTransferMessageSchema = z
  .object({
    itemId: id,
    revision: z.number().int().nonnegative(),
    sequence: z.number().int().nonnegative(),
    sequenceIndex: z.number().int().nonnegative(),
    role: z.enum(['user', 'assistant']),
    kind: id,
    text: z.string()
  })
  .strict()
const capture = z
  .object({
    selectionVersion: z.literal(1),
    messages: z.array(contextTransferMessageSchema),
    coverage: z
      .object({
        eligibleCount: z.number().int().nonnegative(),
        omittedCount: z.number().int().nonnegative(),
        firstItemId: id.nullable(),
        lastItemId: id.nullable(),
        inventoryDigest: id
      })
      .strict()
  })
  .strict()
const identity = { id, sessionId: id, handoffId: id }
const handoff = z
  .object({
    ...identity,
    kind: z.literal('handoff'),
    sourceLink: link,
    sourceCursor: cursor.nullable(),
    contextFloor: cursor.nullable(),
    trigger: z.enum([
      'codex-no-rollout',
      'pi-session-missing',
      'acp-load-rejected',
      'uncertain-context-delivery',
      'context-edit'
    ]),
    capturedAt: time,
    capture,
    supersedesHandoffId: id.optional()
  })
  .strict()
const target = z
  .object({
    ...identity,
    kind: z.literal('target'),
    preparedAt: time,
    fence: z.number().int().nonnegative(),
    acquisitionGeneration: id.nullable(),
    sourceLinkId: id,
    predecessorTargetId: id.nullable(),
    targetLink: link.nullable(),
    firstInputId: id.nullable()
  })
  .strict()
const outcome = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('injected'), at: time, requestId: id }).strict(),
  z
    .object({
      kind: z.literal('inline-accepted'),
      at: time,
      clientMessageId: id,
      providerItemIdentity: id
    })
    .strict(),
  z.object({ kind: z.literal('not-required'), at: time }).strict(),
  z.object({ kind: z.literal('unsupported'), at: time }).strict(),
  z.object({ kind: z.literal('refused-before-write'), at: time, failureKind: id }).strict(),
  z.object({ kind: z.literal('unknown'), at: time, reason: id }).strict()
])
const delivery = z
  .object({
    ...identity,
    kind: z.literal('delivery'),
    targetId: id,
    mode: z.enum(['inject', 'inline', 'none']),
    carrierInputId: id.nullable(),
    preparedAt: time,
    selection: z
      .object({
        itemIds: z.array(id),
        omittedCount: z.number().int().nonnegative(),
        coverageText: z.string(),
        encodedContext: z.string(),
        digest: id,
        encodingVersion: z.literal(1)
      })
      .strict(),
    writeStartedAt: time.optional(),
    outcome: outcome.nullable()
  })
  .strict()
const closure = z
  .object({
    ...identity,
    kind: z.literal('closure'),
    commandId: id,
    at: time,
    cause: z.enum(['context-clear', 'rewind']),
    successorHandoffId: id.optional()
  })
  .strict()
export const contextTransferRecordSchema = z.discriminatedUnion('kind', [
  handoff,
  target,
  delivery,
  closure
])
export type ContextTransferRecord = z.infer<typeof contextTransferRecordSchema>
export type ContextTransferHandoff = z.infer<typeof handoff>
export type ContextTransferTarget = z.infer<typeof target>
export type ContextTransferDelivery = z.infer<typeof delivery>
export type ContextTransferCapture = z.infer<typeof capture>
export type ContextTransferMessage = z.infer<typeof contextTransferMessageSchema>
