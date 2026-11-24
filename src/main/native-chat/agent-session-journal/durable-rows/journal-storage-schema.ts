import { z } from 'zod'
import {
  AgentJournalKnownSchemas,
  AgentJournalRenderItemSchema
} from '../../../../shared/agent-session/journal/agent-session-journal-schemas'
import { AgentJournalSubmissionSchema } from '../../../../shared/agent-session/journal/agent-session-journal-submission-schema'
import { AgentSessionFailureFactSchema } from '../../../../shared/agent-session/failures/agent-session-failure-fact-schema'
import type { AgentSessionFailureFact } from '../../../../shared/agent-session/failures/agent-session-failure'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { StorageDeclaresAll, UndeclaredStorageKeys } from './journal-storage-strict'
import { storedRefusalReference } from './journal-storage-refusal-schema'
import {
  storedAutomationSaved,
  storedBotStatusNotes,
  storedWaitEnded,
  storedConnectorAsker,
  storedAutomationRun,
  storedAutomationRunNotStarted,
  storedBotItemNote
} from '../journal-storage-bot-schema'

// What saved outcomes declare beyond the wire's open schemas, which read only the keys their
// readers use: the shared definitions are reused and completed here. A persisted type gaining a key
// fails the checks at the end of this file until the key is declared; an added optional key needs
// no new format. Keys newly declared here are optional and loosely typed, since only their
// presence decides whether this build understands a value.

const [
  textBlock,
  toolCallBlock,
  toolResultBlock,
  imageRefBlock,
  subagentGroupBlock,
  subagentBlock,
  backgroundTaskBlock
] = AgentJournalKnownSchemas.blocks
const [
  messageBody,
  agentStartBody,
  agentHandoffBody,
  toolCallBody,
  diffBody,
  approvalBody,
  questionBody,
  statusBody,
  turnBody,
  automationSavedBody,
  toolAddedBody,
  waitEndedBody,
  automationRunNotStartedBody,
  botItemNoteBody
] = AgentJournalKnownSchemas.bodies

const text = z.string().optional()
const count = z.number().optional()

export const storedFailureFact = AgentSessionFailureFactSchema.extend({
  account: text,
  refusal: storedRefusalReference.optional(),
  attachment: z.object({ reason: z.string(), limit: count }).optional(),
  retry: z
    .object({ error: text, status: count, cause: text, attempt: count, maxRetries: count })
    .optional(),
  usageLimit: z.object({ window: text, resetsAt: count }).optional(),
  neverReachedAgent: z.literal(true).optional(),
  backgroundStop: text,
  requestTimeout: z.object({ method: z.string(), timeoutMs: z.number() }).optional()
})

// A sender's reader salvages any value of a known key, so only the keys are storage's to close.
const salvaged = z.unknown().optional()
const sender = z.object({
  party: z
    .object({ address: salvaged, terminalHandle: salvaged, orcaSessionId: salvaged })
    .nullable()
    .optional(),
  name: salvaged,
  agent: salvaged,
  relation: salvaged,
  toConversation: salvaged,
  bot: salvaged,
  host: salvaged,
  botAvatar: salvaged
})
const orchestration = z.discriminatedUnion('message', [
  z.object({
    message: z.literal('mail-notice'),
    mailbox: salvaged,
    dispatchId: salvaged,
    messages: z
      .array(
        z.object({
          messageId: salvaged,
          runId: salvaged,
          from: salvaged,
          content: z
            .object({ subject: salvaged, body: salvaged, payload: salvaged })
            .nullable()
            .optional()
        })
      )
      .nullable()
      .optional()
  }),
  z.object({ message: z.literal('task'), runId: salvaged, taskId: salvaged, dispatchId: salvaged })
])
const messageSource = z.object({
  kind: salvaged,
  senders: z.array(sender.nullable()).nullable().optional(),
  orchestration: orchestration.nullable().optional()
})

const storedConnectorDelivery = z.object({
  account: z.string(),
  conversation: z.object({ source: z.string(), externalId: z.string() }),
  deliveryId: z.string(),
  carried: z.array(z.string()).optional()
})

const block = z.discriminatedUnion('type', [
  textBlock.extend({
    contextClear: z
      .object({ operationId: z.string(), afterFence: z.number(), clearedAt: z.number() })
      .optional(),
    failure: storedFailureFact.optional(),
    orcaStop: z.object({ cause: z.string(), turnItemId: text }).optional(),
    usageLimitTurnItemId: text,
    ...storedBotStatusNotes,
    automationResultCleared: z.literal(true).optional(),
    forkedFrom: z
      .object({
        sessionId: z.string(),
        sourceForked: z.literal(true).optional(),
        sourceMissing: z.literal(true).optional()
      })
      .optional()
  }),
  toolCallBlock.extend({ state: text, endedAs: text }),
  toolResultBlock.extend({
    callId: text,
    editPatch: z
      .object({
        filePath: text,
        hunks: z.array(
          z.object({
            oldStart: z.number(),
            oldLines: z.number(),
            newStart: z.number(),
            newLines: z.number(),
            lines: z.array(z.string())
          })
        )
      })
      .optional(),
    fullOutputItemId: text
  }),
  imageRefBlock,
  subagentGroupBlock,
  subagentBlock,
  backgroundTaskBlock
])

export const storedMessageBody = messageBody.extend({
  blocks: z.array(block),
  from: messageSource.nullable().optional(),
  typedBy: z
    .discriminatedUnion('by', [
      z.object({ by: z.literal('host') }),
      z.object({
        by: z.literal('device'),
        deviceId: z.string(),
        account: z.string().optional(),
        accountId: z.string().optional(),
        own: z.boolean().optional(),
        computer: z.string().optional(),
        phone: z.string().optional(),
        verified: z.literal('share').optional()
      }),
      z.object({ by: z.literal('agent') })
    ])
    .optional(),
  origin: text,
  asker: storedConnectorAsker.optional(),
  connectorConversation: z.object({ source: z.string(), externalId: z.string() }).optional(),
  leaveEligible: z.literal(true).optional(),
  connectorDelivery: storedConnectorDelivery.optional(),
  connectorClaim: z
    .object({
      cutTurnId: z.string(),
      cutKind: z.enum(['restart', 'usage_limit']),
      origin: z.array(storedConnectorDelivery)
    })
    .optional(),
  tookOver: z
    .object({ workspace: z.string(), goal: text, home: z.literal(true).optional() })
    .optional(),
  memorySource: text,
  triggeredBy: z
    .object({ source: z.string(), event: text, actor: text, actorId: text, place: text })
    .optional(),
  automationRun: storedAutomationRun.optional()
})

export const storedItemBody = z.discriminatedUnion('kind', [
  storedMessageBody,
  agentStartBody.extend({
    worker: sender.nullable().optional(),
    agent: text,
    followUp: z.object({ of: z.string(), reopened: z.boolean() }).optional()
  }),
  agentHandoffBody.extend({ agent: sender.nullable().optional() }),
  toolCallBody,
  diffBody,
  approvalBody,
  questionBody,
  statusBody.extend({
    ...storedBotStatusNotes,
    failure: storedFailureFact.optional(),
    turnLifecycle: turnBody.omit({ kind: true }).optional()
  }),
  turnBody,
  automationSavedBody.extend(storedAutomationSaved),
  toolAddedBody,
  waitEndedBody.extend(storedWaitEnded),
  automationRunNotStartedBody.extend(storedAutomationRunNotStarted),
  botItemNoteBody.extend(storedBotItemNote)
])

export const storedProviderHandle = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('codex'), threadId: z.string() }),
  z.object({ kind: z.literal('claude'), sessionId: z.string(), leafUuid: z.string().nullable() }),
  z.object({ kind: z.literal('opaque'), agent: z.string(), value: z.string() })
])

export const storedItem = AgentJournalRenderItemSchema.extend({ body: storedItemBody })

export const storedSubmission = AgentJournalSubmissionSchema.extend({
  rejection: storedFailureFact.optional(),
  acceptedSequence: count,
  origin: z.enum(['client', 'host']).optional()
})

export type StoredValuesAreDeclared = [
  StorageDeclaresAll<UndeclaredStorageKeys<AgentJournalRenderItem, z.output<typeof storedItem>>>,
  StorageDeclaresAll<
    UndeclaredStorageKeys<AgentJournalSubmission, z.output<typeof storedSubmission>>
  >,
  StorageDeclaresAll<
    UndeclaredStorageKeys<AgentSessionFailureFact, z.output<typeof storedFailureFact>>
  >
]
