import { BotMemoryUpdatedNoteSchema } from '../../../shared/bots/bot-memory-updated-note'
// What a bot's chat adds to a saved journal, declared so strict storage keeps it.
import { z } from 'zod'
import { lazyZodSchema } from '../../../shared/schema/lazy-zod-schema'
import { storedRefusalReference } from './durable-rows/journal-storage-refusal-schema'

const text = lazyZodSchema(() => z.string().optional())

export const storedConnectorAsker = lazyZodSchema(() =>
  z.object({
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
)

export const storedAutomationResultNote = lazyZodSchema(() =>
  z.object({
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
)

export const storedBotContextNote = lazyZodSchema(() =>
  z.object({ botId: z.string(), changed: z.array(z.string()) })
)

export const storedConnectorOffer = lazyZodSchema(() =>
  z.object({
    botId: z.string(),
    source: z.string(),
    workspace: text,
    addAccess: z.literal(true).optional(),
    signIn: z.literal(true).optional()
  })
)

export const storedBotRequestCard = lazyZodSchema(() =>
  z.object({
    toBotId: z.string(),
    toBotName: z.string(),
    purpose: z.string(),
    subject: z.string(),
    messageId: text,
    refusal: text,
    client: z.object({ installationId: z.string(), computer: z.string() }).optional()
  })
)

/** Saved by builds that had bot take-over; still read so those chats open, as their plain text. */
const legacyHandoffOffer = lazyZodSchema(() =>
  z.object({
    botId: z.string(),
    area: z.string(),
    workspaces: z.array(z.object({ id: z.string(), name: z.string(), detail: z.string() }))
  })
)

export const storedBotCreateOffer = lazyZodSchema(() =>
  z.object({
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
)

const importLine = lazyZodSchema(() => z.string())

export const storedBotImportPlan = lazyZodSchema(() =>
  z.object({
    botId: z.string(),
    app: importLine,
    name: importLine,
    again: z.boolean().optional(),
    items: z.array(z.object({ group: z.string(), what: importLine, to: text, why: importLine }))
  })
)

export const storedBotImportDone = lazyZodSchema(() =>
  z.object({
    botId: z.string(),
    app: importLine,
    name: importLine,
    created: z.array(z.object({ kind: z.string(), what: importLine, detail: text })),
    stayed: z.array(importLine),
    paused: z.number()
  })
)

const resultPlace = { ref: text, label: text }

/** What an automation-saved card keeps of the automation, and where its results go. */
export const storedAutomationSaved = {
  automation: lazyZodSchema(() =>
    z.object({
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
    })
  ),
  resultsTo: lazyZodSchema(() =>
    z
      .union([
        z.string(),
        z.object({ channel: z.string(), ...resultPlace }),
        z.object({ linearIssue: z.string(), ...resultPlace })
      ])
      .optional()
  ),
  agentSetup: lazyZodSchema(() =>
    z
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
  )
}

/** What a wait-ended card keeps: the wait as it was saved, and how it ended. */
export const storedWaitEnded = {
  automation: storedAutomationSaved.automation,
  ending: lazyZodSchema(() => z.object({ kind: z.string(), at: z.number(), actor: text }))
}

/** What a run's message or its Couldn't start card keeps: the run as delivered. */
export const storedAutomationRun = lazyZodSchema(() =>
  z.object({
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
)

export const storedAutomationRunNotStarted = {
  run: storedAutomationRun,
  actsFor: lazyZodSchema(() =>
    z.array(
      z.object({
        kind: z.string(),
        source: text,
        userId: text,
        name: text,
        workspaceId: z.string().nullable().optional(),
        role: z.string().nullable().optional(),
        placeKind: text
      })
    )
  ),
  error: lazyZodSchema(() => z.string()),
  refusal: lazyZodSchema(() => storedRefusalReference.optional()),
  text: lazyZodSchema(() => z.string()),
  at: lazyZodSchema(() => z.number())
}

/** An item note's entries beyond what every entry has. */
export const storedBotItemNote = {
  entries: lazyZodSchema(() =>
    z.array(
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
  )
}

/** On a status line: a bot's automation result, context note, tidy-up line, Connect card, new-bot offer,
 *  request to another bot, or setup card. */
export const storedBotStatusNotes = {
  automationResult: lazyZodSchema(() => storedAutomationResultNote.optional()),
  botContext: lazyZodSchema(() => storedBotContextNote.optional()),
  botMemoryUpdated: lazyZodSchema(() => BotMemoryUpdatedNoteSchema.optional()),
  tidyUp: lazyZodSchema(() => z.object({ botId: z.string(), changes: z.number() }).optional()),
  connectorOffer: lazyZodSchema(() => storedConnectorOffer.optional()),
  handoffOffer: lazyZodSchema(() => legacyHandoffOffer.optional()),
  botCreateOffer: lazyZodSchema(() => storedBotCreateOffer.optional()),
  botImportPlan: lazyZodSchema(() => storedBotImportPlan.optional()),
  botImportDone: lazyZodSchema(() => storedBotImportDone.optional()),
  botRequest: lazyZodSchema(() => storedBotRequestCard.optional()),
  googleSetup: lazyZodSchema(() =>
    z
      .object({
        botId: z.string(),
        runId: z.string(),
        card: z.string(),
        step: text,
        copy: z.number().optional()
      })
      .optional()
  ),
  composioSetup: lazyZodSchema(() =>
    z
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
      .optional()
  ),
  // Saved by builds that had bot take-over; still read so those chats open, as their plain text.
  workspaceRemoved: lazyZodSchema(() =>
    z.object({ botId: z.string(), name: z.string() }).optional()
  )
}
