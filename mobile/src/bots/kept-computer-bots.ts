// Each paired computer's last answers for Home, kept beside its servers' kept listings so a computer that
// is down after a phone restart still lists its bots, dimmed.
import * as z from 'zod'
import type { BotGroup } from '../../../src/shared/bots/bot-group'
import { normalizeBotSidebarView } from '../../../src/shared/bots/bot-sidebar-view'
import type { ExecutionHostId } from '../../../src/shared/execution-host/execution-host'
import type { BotComputerAnswer } from './bot-link-host-reads'
import { phoneBotSchema } from './host-bots-operations'
import { keptServerBotStore as deviceStore } from './kept-server-bot-store'
import {
  keepRecord,
  keptBotsGeneration,
  keptBotsUsable,
  keptSlot,
  stored
} from './kept-server-bot-listings'

const COMPUTER_KEY = 'bots.homeComputer.v1'

const someObject = (value: unknown): boolean => typeof value === 'object' && value !== null

/** One computer's last good answer, and when it was read. */
export type KeptComputerAnswer = BotComputerAnswer & { readAt: number }

/** A paired computer's last answers: what each computer lists, which are too old or switched off, and
 *  which take a new bot; its rooms; and each row's last activity. Live counts (Needs you, waits) stay out. */
export type KeptComputerBots = {
  answers: readonly KeptComputerAnswer[]
  groups: readonly BotGroup[]
  lastActivity: Readonly<Record<string, number>>
}

const keptAnswerSchema = z.object({
  key: z.string(),
  pairedHostId: z.string(),
  executionHost: z.custom<ExecutionHostId>((value) => typeof value === 'string'),
  serverLabel: z.string().optional(),
  installationId: z.string().optional(),
  readAt: z.number().catch(0),
  answer: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('bots'),
      bots: z.array(phoneBotSchema),
      hideBotCreated: z.boolean(),
      view: z.unknown().transform(normalizeBotSidebarView),
      enabled: z.boolean(),
      takesCreate: z.boolean(),
      takesTemplates: z.boolean()
    }),
    z.object({ kind: z.literal('no-capability') })
  ])
})

const keptComputerSchema = z.object({
  answers: z.array(keptAnswerSchema),
  groups: z.array(z.custom<BotGroup>(someObject)),
  lastActivity: z.record(z.string(), z.number())
})

function serializeComputer(kept: KeptComputerBots): string {
  return JSON.stringify({
    answers: kept.answers.flatMap((entry): unknown[] =>
      entry.answer.kind === 'bots'
        ? [
            {
              ...entry,
              answer: {
                kind: 'bots',
                bots: entry.answer.bots,
                hideBotCreated: entry.answer.hideBotCreated,
                view: entry.answer.view,
                enabled: entry.answer.enabled,
                takesCreate: entry.answer.takesCreate,
                takesTemplates: entry.answer.takesTemplates
              }
            }
          ]
        : entry.answer.kind === 'no-capability'
          ? [entry]
          : []
    ),
    groups: kept.groups,
    lastActivity: kept.lastActivity
  })
}

/** Keeps a paired computer's newest answers for Home; an unchanged record is never written again. */
export function keepComputerBots(pairedHostId: string, kept: KeptComputerBots): void {
  keepRecord(pairedHostId, COMPUTER_KEY, serializeComputer(kept))
}

/** Each paired computer's kept answers, or null when it holds none (or none usable, or there is no
 *  device store). One whose read failed, or that was unpaired or revoked while it was out, is left out:
 *  unread is not empty. */
export async function readKeptComputerBots(
  pairedHostIds: readonly string[]
): Promise<Record<string, KeptComputerBots | null>> {
  const opened = await deviceStore().then(
    (store) => ({ store }),
    () => null
  )
  if (!opened) {
    return {}
  }
  const { store } = opened
  if (!store) {
    return Object.fromEntries(pairedHostIds.map((id) => [id, null]))
  }
  const reads = await Promise.all(
    pairedHostIds.map(async (pairedHostId) => {
      const generation = keptBotsGeneration(pairedHostId)
      const read = await store.read(pairedHostId, 'cache', [COMPUTER_KEY]).catch(() => null)
      if (read?.status !== 'ok' || !keptBotsUsable(pairedHostId, generation)) {
        return null
      }
      const raw = read.values[0] ?? null
      const at = keptSlot(pairedHostId, COMPUTER_KEY)
      if (!stored.has(at)) {
        stored.set(at, raw)
      }
      if (raw === null) {
        return [pairedHostId, null] as const
      }
      try {
        const parsed = keptComputerSchema.safeParse(JSON.parse(raw))
        if (!parsed.success) {
          return [pairedHostId, null] as const
        }
        const answers = parsed.data.answers.map((entry): KeptComputerAnswer =>
          entry.answer.kind === 'bots'
            ? { ...entry, answer: { ...entry.answer, waits: {}, needsYou: {} } }
            : { ...entry, answer: entry.answer }
        )
        return [pairedHostId, { ...parsed.data, answers }] as const
      } catch {
        return [pairedHostId, null] as const
      }
    })
  )
  return Object.fromEntries(reads.filter((entry) => entry !== null))
}
