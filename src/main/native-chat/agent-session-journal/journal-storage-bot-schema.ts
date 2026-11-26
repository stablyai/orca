import { BotMemoryUpdatedNoteSchema } from '../../../shared/bots/bot-memory-updated-note'
// What a bot's chat adds to a saved journal, declared so strict storage keeps it.
import { z } from 'zod'
import { storedRefusalReference } from './durable-rows/journal-storage-refusal-schema'

const text = z.string().optional()

export const storedConnectorAsker = z.object({
  source: z.string(),
  userId: z.string(),
  name: text,
  role: z.string(),
  place: z.object({ kind: z.string(), id: z.string() }),
  url: text,
  avatarUrl: text,
  messageRef: text,
  noAccess: z.array(z.object({ name: text, text: z.string() })).optional(),
  via: z.object({ userId: z.string(), name: z.string() }).optional(),
  app: z.literal(true).optional()
})

export const storedAutomationResultNote = z.object({
  automationId: z.string(),
  automationName: z.string(),
  botName: z.string(),
  runId: z.string(),
  sessionId: text,
  trigger: z.string(),
  outcome: z.string(),
  result: z.string(),
  at: z.number(),
  readWith: text
})

export const storedBotContextNote = z.object({ botId: z.string(), changed: z.array(z.string()) })

export const storedConnectorOffer = z.object({
  botId: z.string(),
  source: z.string(),
  workspace: text,
  addAccess: z.literal(true).optional(),
  signIn: z.literal(true).optional()
})

export const storedBotRequestCard = z.object({
  toBotId: z.string(),
  toBotName: z.string(),
  purpose: z.string(),
  subject: z.string(),
  messageId: text,
  refusal: text,
  client: z.object({ installationId: z.string(), computer: z.string() }).optional()
})

/** Saved by builds that had bot take-over; still read so those chats open, as their plain text. */
const legacyHandoffOffer = z.object({
  botId: z.string(),
  area: z.string(),
  workspaces: z.array(z.object({ id: z.string(), name: z.string(), detail: z.string() }))
})

export const storedBotCreateOffer = z.object({
  botId: z.string(),
  offerId: z.string(),
  proposal: z.object({
    name: z.string(),
    purpose: z.string(),
    watches: text,
    does: text,
    reports: text,
    automations: z.array(z.string()).optional(),
    templateId: text,
    mascot: text,
    worktrees: z.array(z.object({ id: z.string(), name: z.string() })).optional()
  }),
  offeredAt: z.number()
})

const importLine = z.string()

export const storedBotImportPlan = z.object({
  botId: z.string(),
  app: importLine,
  name: importLine,
  again: z.boolean().optional(),
  items: z.array(z.object({ group: z.string(), what: importLine, to: text, why: importLine }))
})

export const storedBotImportDone = z.object({
  botId: z.string(),
  app: importLine,
  name: importLine,
  created: z.array(z.object({ kind: z.string(), what: importLine, detail: text })),
  stayed: z.array(importLine),
  paused: z.number()
})

const resultPlace = { ref: text, label: text }

/** What an automation-saved card keeps of the automation, and where its results go. */
export const storedAutomationSaved = {
  automation: z.object({
    id: z.string(),
    name: z.string(),
    enabled: z.boolean(),
    nextRunAt: z.number(),
    updatedAt: z.number(),
    dtstart: z.number(),
    rrule: z.string(),
    workspaceId: z.string().nullable(),
    on: z
      .array(
        z.object({
          id: z.string(),
          source: z.string(),
          event: z.string(),
          in: z.array(z.string()).optional(),
          subject: text,
          names: z.record(z.string(), z.string()).optional()
        })
      )
      .optional(),
    bot: z.object({ botId: z.string() }).optional(),
    once: z.object({ by: z.number().optional() }).optional()
  }),
  resultsTo: z
    .union([
      z.string(),
      z.object({ channel: z.string(), ...resultPlace }),
      z.object({ linearIssue: z.string(), ...resultPlace })
    ])
    .optional(),
  agentSetup: z
    .object({
      agent: z.string(),
      launch: z
        .object({
          model: z.string().optional(),
          options: z.record(z.string(), z.string()).optional()
        })
        .optional()
    })
    .optional()
}

/** What a wait-ended card keeps: the wait as it was saved, and how it ended. */
export const storedWaitEnded = {
  automation: storedAutomationSaved.automation,
  ending: z.object({ kind: z.string(), at: z.number(), actor: text })
}

/** What a run's message or its Couldn't start card keeps: the run as delivered. */
export const storedAutomationRun = z.object({
  runId: z.string(),
  automation: storedAutomationSaved.automation,
  trigger: z.string(),
  scheduledFor: z.number().optional(),
  wait: storedWaitEnded.ending.optional(),
  toConversation: z.literal(true).optional(),
  event: z
    .object({
      source: z.string(),
      event: z.string(),
      occurredAt: z.number(),
      place: text,
      url: text,
      actor: text,
      replayed: z.literal(true).optional(),
      text,
      textShortened: z.literal(true).optional(),
      asker: text,
      webhook: z
        .object({
          hookId: z.string(),
          callId: z.string(),
          sample: z.literal(true).optional(),
          firstCall: z.literal(true).optional()
        })
        .optional()
    })
    .optional(),
  instructionsLength: z.number()
})

export const storedAutomationRunNotStarted = {
  run: storedAutomationRun,
  actsFor: z.array(
    z.object({
      kind: z.string(),
      source: text,
      userId: text,
      name: text,
      workspaceId: z.string().nullable().optional(),
      role: z.string().nullable().optional(),
      placeKind: text,
      viaAccount: text
    })
  ),
  error: z.string(),
  refusal: storedRefusalReference.optional(),
  text: z.string(),
  at: z.number()
}

/** An item note's entries beyond what every entry has. */
export const storedBotItemNote = {
  entries: z.array(
    z.object({
      uid: z.string(),
      number: z.number(),
      title: z.string(),
      status: z.string(),
      event: z.string(),
      from: text,
      to: text,
      note: text,
      fields: z.array(z.string()).optional(),
      doneMeans: z.string().nullable().optional(),
      text,
      images: z
        .array(z.object({ path: z.string(), name: z.string(), bytes: z.number() }))
        .optional(),
      refs: z.array(z.string()).optional(),
      names: z.record(z.string(), z.string()).optional()
    })
  )
}

/** On a status line: a bot's automation result, context note, tidy-up line, Connect card, new-bot offer,
 *  request to another bot, or setup card. */
export const storedBotStatusNotes = {
  automationResult: storedAutomationResultNote.optional(),
  botContext: storedBotContextNote.optional(),
  botMemoryUpdated: BotMemoryUpdatedNoteSchema.optional(),
  tidyUp: z.object({ botId: z.string(), changes: z.number() }).optional(),
  connectorOffer: storedConnectorOffer.optional(),
  handoffOffer: legacyHandoffOffer.optional(),
  botCreateOffer: storedBotCreateOffer.optional(),
  botImportPlan: storedBotImportPlan.optional(),
  botImportDone: storedBotImportDone.optional(),
  botRequest: storedBotRequestCard.optional(),
  googleSetup: z
    .object({
      botId: z.string(),
      runId: z.string(),
      card: z.string(),
      step: text,
      copy: z.number().optional()
    })
    .optional(),
  composioSetup: z
    .object({
      botId: z.string(),
      card: z.string(),
      app: z.object({ slug: z.string(), name: z.string() }).optional(),
      hookId: z.string().optional(),
      trigger: z
        .object({ slug: z.string(), name: z.string(), config: z.string().optional() })
        .optional(),
      reason: z.string().optional(),
      step: z.object({ index: z.number(), total: z.number() }).optional()
    })
    .optional(),
  // Saved by builds that had bot take-over; still read so those chats open, as their plain text.
  workspaceRemoved: z.object({ botId: z.string(), name: z.string() }).optional()
}
