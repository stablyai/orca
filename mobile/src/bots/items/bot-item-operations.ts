// The owner's item calls from the phone: the host the route reaches (a paired server's too) reads and
// changes the bot's items. Only a comment carries a request id (where the host takes one), so only a
// comment's Retry is safe after a dropped reply.
import { botFailureMessage } from '../bot-failure-message'
import * as z from 'zod'
import {
  BotItemShowReadSchema,
  BotItemsListReadSchema,
  type BotItemShowRead,
  type BotItemsListRead
} from '../../../../src/shared/bots/bot-item-schema'
import type {
  BotItem,
  BotItemCommentSkill,
  BotItemStatus
} from '../../../../src/shared/bots/bot-items'
import { readHostMethodReply } from '../../host-screen/sidebar-feed/host-sidebar-feed-operations'
import { isRpcDeliveryUnknown } from '../../transport/rpc/rpc-delivery-ambiguity'
import { RpcRefusedError } from '../../transport/rpc/rpc-refused-error'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { bindDeferredRpcOperation, defineRpcOperation } from '../../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../../transport/rpc/rpc-operation-result-reader'

const itemsList = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.items.owner.list-or-skip',
    method: 'bots.items.owner.list',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('bot-items', z.unknown().pipe(BotItemsListReadSchema))
  })
)

const itemShow = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.items.owner.show-or-skip',
    method: 'bots.items.owner.show',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('bot-item', z.unknown().pipe(BotItemShowReadSchema))
  })
)

const itemsOpened = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.items.owner.opened',
    method: 'bots.items.owner.opened',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('bot-items-opened', z.unknown())
  })
)

const itemComment = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.items.owner.comment',
    method: 'bots.items.owner.comment',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('bot-item-commented', z.unknown())
  })
)

const itemsStatus = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.items.owner.status',
    method: 'bots.items.owner.status',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('bot-items-moved', z.unknown())
  })
)

const itemsSnooze = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.items.owner.snooze',
    method: 'bots.items.owner.snooze',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('bot-items-snoozed', z.unknown())
  })
)

/** One chat goes as `chatId`, which hosts from before `chatIds` read too, as the desktop sends it. */
function botItemsChatScope(
  chatIds: readonly string[] | null
): { chatId: string } | { chatIds: string[] } | Record<string, never> {
  if (chatIds === null) {
    return {}
  }
  return chatIds.length === 1 ? { chatId: chatIds[0]! } : { chatIds: [...chatIds] }
}

/** `message` says why a read failed: the host's refusal or the transport's error, when either gave one. */
export type BotItemRead<T> =
  | { kind: 'read'; value: T }
  | { kind: 'failed'; notFound: boolean; message?: string }

/** Open items and a page of closed items, optionally scoped to a group’s rooms. */
export async function readBotItems(
  client: RpcClient,
  botId: string,
  { chatIds, ...page }: { chatIds?: readonly string[] | null; closedCursor?: string } = {}
): Promise<BotItemRead<BotItemsListRead>> {
  try {
    const answer = readHostMethodReply(
      await itemsList.request(client, { botId, ...page, ...botItemsChatScope(chatIds ?? null) }),
      itemsList.interpret
    )
    return answer.kind === 'answered'
      ? { kind: 'read', value: answer.value }
      : {
          kind: 'failed',
          notFound: false,
          message: answer.kind === 'failed' ? answer.message : undefined
        }
  } catch (error) {
    return { kind: 'failed', notFound: false, message: error instanceof Error ? error.message : '' }
  }
}

/** One item by uid: its newest Activity page, events after `after`, or the page before `before`. */
export async function readBotItem(
  client: RpcClient,
  uid: string,
  page: { after: string } | { newest: true; before?: string }
): Promise<BotItemRead<BotItemShowRead>> {
  try {
    const reply = await itemShow.request(client, { item: uid, ...page })
    if (!reply.ok) {
      return { kind: 'failed', notFound: reply.error.code === 'not_found' }
    }
    const answer = readHostMethodReply(reply, itemShow.interpret)
    return answer.kind === 'answered'
      ? { kind: 'read', value: answer.value }
      : { kind: 'failed', notFound: false }
  } catch {
    return { kind: 'failed', notFound: false }
  }
}

/** Moves the bot's one seen mark, so the desktop and the phone agree on what is new. */
export function markBotItemsOpened(client: RpcClient, botId: string): void {
  void itemsOpened.request(client, { botId }).catch(() => {})
}

/** How an owner write went: `unknown` when the connection dropped after sending, so it may have landed. */
export type BotItemWriteOutcome =
  | { kind: 'done'; result?: unknown }
  | { kind: 'refused'; message: string; code?: string }
  | { kind: 'unknown' }
  | { kind: 'not-sent' }

async function write(send: () => Promise<unknown>): Promise<BotItemWriteOutcome> {
  let reply: unknown
  try {
    reply = await send()
  } catch (error) {
    return isRpcDeliveryUnknown(error) ? { kind: 'unknown' } : { kind: 'not-sent' }
  }
  return reply instanceof Error
    ? {
        kind: 'refused',
        message: botFailureMessage(reply) ?? reply.message,
        ...(reply instanceof RpcRefusedError ? { code: reply.code } : {})
      }
    : { kind: 'done', result: reply }
}

/** `images`: committed attachment store paths on the bot's host; `requestId` only to a host that
 *  takes one. Done carries the host's answer, `{ eventId }`. */
export function commentOnBotItem(
  client: RpcClient,
  uid: string,
  text: string,
  extra: {
    images?: readonly string[]
    requestId?: string
    skills?: readonly BotItemCommentSkill[]
    /** The ask the comment answers; `plain`: it answers none. */
    questionId?: string
    plain?: boolean
  } = {}
): Promise<BotItemWriteOutcome> {
  return write(async () => {
    const reply = await itemComment.request(
      client,
      {
        item: uid,
        text,
        ...(extra.images?.length ? { images: [...extra.images] } : {}),
        ...(extra.requestId ? { requestId: extra.requestId } : {}),
        ...(extra.skills?.length ? { skills: [...extra.skills] } : {}),
        ...(extra.questionId ? { questionId: extra.questionId } : {}),
        ...(extra.plain ? { plain: true } : {})
      },
      { failWhenDisconnected: true }
    )
    try {
      return itemComment.interpret(reply)
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error))
    }
  })
}

/** One status for any number of items: one mail per chat, so one turn for the bot. `note`: Cancel's
 *  reason, or what Waiting waits on. */
export function setBotItemsStatus(
  client: RpcClient,
  uids: readonly string[],
  status: BotItemStatus,
  note?: string
): Promise<BotItemWriteOutcome> {
  return write(async () => {
    const reply = await itemsStatus.request(
      client,
      {
        items: [...uids],
        status,
        ...(note ? (status === 'waiting' ? { note } : { reason: note }) : {})
      },
      { failWhenDisconnected: true }
    )
    try {
      itemsStatus.interpret(reply)
      return null
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error))
    }
  })
}

/** Snoozes items until `until`, or brings them back with null; no mail. Each carries the newest change
 *  by the bot this phone showed, so the host refuses a snooze over something new. */
export function snoozeBotItems(
  client: RpcClient,
  items: readonly Pick<BotItem, 'uid' | 'othersLastEventId'>[],
  until: number | null
): Promise<BotItemWriteOutcome> {
  return write(async () => {
    const reply = await itemsSnooze.request(
      client,
      {
        items: items.map((item) => ({ item: item.uid, othersLastEventId: item.othersLastEventId })),
        until
      },
      { failWhenDisconnected: true }
    )
    try {
      itemsSnooze.interpret(reply)
      return null
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error))
    }
  })
}
