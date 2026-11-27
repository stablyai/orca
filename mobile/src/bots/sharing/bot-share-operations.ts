// Sharing a bot by link from the phone: the desktop's bots.share.* calls, on the bot's own computer,
// whose Orca account publishes and lists its links.
import * as z from 'zod'
import { BotShareOutsidePickSchema } from '../../../../src/shared/bots/bot-share-skill-picks'
import {
  BOT_SHARE_ERRORS,
  type BotShareErrorCode
} from '../../../../src/shared/bots/bot-share-errors'
import type { BotOwnedShare } from '../../../../src/shared/bots/bot-share-status'
import { salvagingArray } from '../../../../src/shared/validation/zod-salvage'
import { bindDeferredRpcOperation, defineRpcOperation } from '../../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../../transport/rpc/rpc-operation-result-reader'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'

export const BOT_SHARE_FLAG_KINDS = [
  'secret',
  'pipe-to-shell',
  'sudo',
  'sends-file',
  'hidden-unicode',
  'runnable'
] as const

const Named = z.looseObject({ name: z.string() })

const FlagSchema = z.looseObject({
  where: z.string(),
  line: z.number().nullable(),
  kind: z.enum(BOT_SHARE_FLAG_KINDS)
})

const CandidateSchema = z.looseObject({
  candidateId: z.string().min(1),
  botDigest: z.string(),
  blocked: z.boolean(),
  bot: z.looseObject({
    purpose: z.string(),
    setupNote: z.string().optional(),
    tools: z.array(Named),
    schedules: z.array(Named),
    eventSuggestions: z.array(Named)
  }),
  leftOut: salvagingArray(
    z.looseObject({
      kind: z.string(),
      name: z.string(),
      why: z.string(),
      from: z.string().optional()
    })
  ),
  notIncluded: z.array(z.string()),
  rewritten: z.array(z.string()).optional(),
  available: z.looseObject({
    soulLines: z.number(),
    skills: z.array(
      z.looseObject({
        name: z.string(),
        description: z.string(),
        homePath: z.string().nullable(),
        optInFrom: z.string().optional(),
        optInKey: z.string().optional()
      })
    ),
    schedules: z.array(
      z.looseObject({ automationId: z.string(), name: z.string(), rrule: z.string() })
    ),
    eventSuggestions: z.array(
      z.looseObject({
        automationId: z.string(),
        name: z.string(),
        source: z.string(),
        event: z.string()
      })
    ),
    tools: z.array(z.looseObject({ name: z.string(), url: z.string() })),
    memory: z.array(z.looseObject({ topic: z.string(), lines: z.number() }))
  }),
  automationIds: z.looseObject({
    schedules: z.array(z.string()),
    eventSuggestions: z.array(z.string())
  }),
  flags: salvagingArray(FlagSchema)
})

export type PhoneShareCandidate = z.infer<typeof CandidateSchema>

const NamesSchema = z.array(z.string()).optional()

/** What the owner ticked; an absent list shares all of that part, except memory (off unless named). */
const SelectionSchema = z.object({
  skills: NamesSchema,
  tools: NamesSchema,
  schedules: NamesSchema,
  eventSuggestions: NamesSchema,
  memory: NamesSchema,
  outsideSkills: z.array(BotShareOutsidePickSchema).optional()
})

export type PhoneShareSelection = z.infer<typeof SelectionSchema>

export const botSharePrepare = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.share.prepare',
    method: 'bots.share.prepare',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant(
      'bot-share-prepared',
      z.looseObject({
        candidate: CandidateSchema,
        last: z.looseObject({ selection: SelectionSchema, setupNote: z.string() }).optional()
      })
    )
  })
)

const PartFileSchema = z.looseObject({
  path: z.string(),
  text: z.string().nullable(),
  flags: salvagingArray(z.looseObject({ line: z.number(), kind: z.enum(BOT_SHARE_FLAG_KINDS) }))
})

export type PhoneSharePartFile = z.infer<typeof PartFileSchema>

export const botShareView = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.share.view',
    method: 'bots.share.view',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('bot-share-part', z.looseObject({ files: z.array(PartFileSchema) }))
  })
)

/** Orca Cloud's answer: a value, or why the computer's account can't give one. */
function cloudOperation<Schema extends z.ZodType>(value: Schema) {
  return z.union([
    z.looseObject({ status: z.literal('ok'), value }),
    z.looseObject({ status: z.literal('unconfigured') }),
    z.looseObject({ status: z.literal('reconnect-required') })
  ])
}

const PublishedSchema = z.looseObject({
  share: z.looseObject({ id: z.string(), url: z.string(), pinnedVersionId: z.string() }),
  version: z.looseObject({ packageDigest: z.string() })
})

export type PhoneSharePublished = z.infer<typeof PublishedSchema>

export const botSharePublish = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.share.publish',
    method: 'bots.share.publish',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('bot-share-published', cloudOperation(PublishedSchema))
  })
)

const OwnedShareSchema = z.looseObject({
  id: z.string(),
  url: z.string(),
  packageId: z.string(),
  name: z.string(),
  createdAt: z.string(),
  canonical: z.boolean(),
  pinnedVersionId: z.string().optional(),
  displayName: z.string().optional(),
  pinnedPublishedAt: z.string().optional(),
  pinnedDigest: z.string().optional()
})

export const botShareStatus = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.share.status',
    method: 'bots.share.status',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('bot-share-status', cloudOperation(salvagingArray(OwnedShareSchema)))
  })
)

export const botShareStop = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.share.stop',
    method: 'bots.share.stop',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('bot-share-stopped', cloudOperation(z.boolean()))
  })
)

const WRITE = { failWhenDisconnected: true } as const

/** An ok cloud answer's value; a signed-out computer throws the desktop's sign-in codes. */
function cloudValue<T>(
  result: { status: 'ok'; value: T } | { status: 'unconfigured' | 'reconnect-required' }
): T {
  if (result.status !== 'ok') {
    throw new Error(
      result.status === 'reconnect-required' ? BOT_SHARE_ERRORS.reconnect : BOT_SHARE_ERRORS.signIn
    )
  }
  return result.value
}

/** Every live bot link the computer's account has; with `botId`, that bot's link carries its digest. */
export async function listPhoneBotShares(
  client: RpcClient,
  botId?: string
): Promise<BotOwnedShare[]> {
  return cloudValue(
    botShareStatus.interpret(await botShareStatus.request(client, botId ? { botId } : {}, WRITE))
  )
}

export async function publishPhoneBotShare(
  client: RpcClient,
  params: {
    botId: string
    candidateId: string
    setupNote: string
    link?: { shareId: string; expectedVersionId: string }
  }
): Promise<PhoneSharePublished> {
  return cloudValue(botSharePublish.interpret(await botSharePublish.request(client, params, WRITE)))
}

/** Stops a link; with `botId`, the computer forgets that bot's last published picks too. */
export async function stopPhoneBotShare(
  client: RpcClient,
  shareId: string,
  botId?: string
): Promise<boolean> {
  return cloudValue(
    botShareStop.interpret(
      await botShareStop.request(client, { shareId, ...(botId ? { botId } : {}) }, WRITE)
    )
  )
}

const CODES = Object.values(BOT_SHARE_ERRORS)

/** The share code a failure carries, whichever host or wrapper it came through. */
export function botShareErrorCode(cause: unknown): BotShareErrorCode | null {
  const message = cause instanceof Error ? cause.message : ''
  return CODES.find((code) => message.includes(code)) ?? null
}

export function isBotShareSignIn(cause: unknown): boolean {
  const code = botShareErrorCode(cause)
  return code === BOT_SHARE_ERRORS.signIn || code === BOT_SHARE_ERRORS.reconnect
}
