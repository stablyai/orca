// Receiving a shared bot on the phone: the link's review, read on the computer the bot will live on.
import * as z from 'zod'
import { BOT_SHARE_RECEIVE_ERRORS } from '../../../../src/shared/bots/bot-share-received'
import { salvagingArray } from '../../../../src/shared/validation/zod-salvage'
import { bindDeferredRpcOperation, defineRpcOperation } from '../../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../../transport/rpc/rpc-operation-result-reader'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { BOT_SHARE_FLAG_KINDS } from './bot-share-operations'

const TEXT_FLAG_KINDS = BOT_SHARE_FLAG_KINDS.filter(
  (kind): kind is Exclude<(typeof BOT_SHARE_FLAG_KINDS)[number], 'runnable'> => kind !== 'runnable'
)

const ReviewSchema = z.looseObject({
  reviewId: z.string().min(1),
  shareId: z.string(),
  versionId: z.string(),
  publisher: z.string().nullable(),
  publishedAt: z.string(),
  bot: z.looseObject({
    name: z.string(),
    purpose: z.string(),
    avatar: z
      .looseObject({
        mascot: z.string().optional(),
        // The shared mascot's look, which the host gives the new bot when it keeps that mascot.
        color: z.string().optional().catch(undefined),
        outfit: z.string().optional().catch(undefined)
      })
      .optional(),
    skills: z.array(z.looseObject({ name: z.string() })),
    tools: z.array(z.looseObject({ id: z.string(), name: z.string(), url: z.string() })),
    connectors: z.array(z.looseObject({ kind: z.string() })),
    schedules: z.array(
      z.looseObject({ id: z.string(), name: z.string(), prompt: z.string(), rrule: z.string() })
    ),
    eventSuggestions: z.array(
      z.looseObject({
        id: z.string(),
        name: z.string(),
        prompt: z.string(),
        source: z.string(),
        event: z.string()
      })
    ),
    memory: z.array(z.looseObject({ topic: z.string() })),
    setupNote: z.string().optional()
  }),
  files: z.array(
    z.looseObject({
      path: z.string(),
      text: z.string(),
      flags: salvagingArray(z.looseObject({ kind: z.enum(TEXT_FLAG_KINDS), line: z.number() }))
    })
  ),
  flags: salvagingArray(
    z.looseObject({
      where: z.string(),
      line: z.number().nullable(),
      kind: z.enum(BOT_SHARE_FLAG_KINDS)
    })
  ),
  leftOut: z.array(z.string()),
  avatarDataUrl: z.string().nullable()
})

export type PhoneShareReview = z.infer<typeof ReviewSchema>

const botShareReview = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.share.review',
    method: 'bots.share.review',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('bot-share-review', z.looseObject({ review: ReviewSchema.nullable() }))
  })
)

/** The version the link serves now; null when it was stopped. */
export async function reviewPhoneBotShare(
  client: RpcClient,
  shareId: string
): Promise<PhoneShareReview | null> {
  return botShareReview.interpret(
    await botShareReview.request(client, { shareId }, { failWhenDisconnected: true })
  ).review
}

const RECEIVE_CODES = ['updated', 'stopped', 'expired'] as const

/** Why Create refused a reviewed link: it moved, stopped, or the review expired; null otherwise. */
export function botShareMoved(cause: unknown): (typeof RECEIVE_CODES)[number] | null {
  const message = cause instanceof Error ? cause.message : ''
  return RECEIVE_CODES.find((code) => message.includes(BOT_SHARE_RECEIVE_ERRORS[code])) ?? null
}
