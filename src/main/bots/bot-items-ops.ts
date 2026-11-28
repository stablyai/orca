// The items store's calls the bots DB worker answers, and their async shape on the main side. Each
// call is one request, and each write is one transaction in the worker.
import type { BotItemsStore } from './bot-items-store'

export const BOT_ITEMS_OPS = [
  'get',
  'byNumber',
  'links',
  'events',
  'eventsBefore',
  'linksTo',
  'itemsLinking',
  'reportFact',
  'linkedDispatchRefs',
  'list',
  'needsYou',
  'viewRows',
  'showRows',
  'closes',
  'add',
  'set',
  'comment',
  'close',
  'link',
  'linkStartedWorker',
  'usageLimitWait',
  'usageLimitWaitUids',
  'orcaComment',
  'ownerComment',
  'ownerCommentByRequest',
  'ownerStatus',
  'ownerSnooze',
  'latestEventId',
  'owedMail',
  'owedCommentAttachmentUploads',
  'markMailSent'
] as const satisfies readonly (keyof BotItemsStore)[]

export type BotItemsOp = (typeof BOT_ITEMS_OPS)[number]

/** The store as the main side reaches it: every call answered by the worker. */
export type BotItemsRemote = {
  [K in BotItemsOp]: BotItemsStore[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<R>
    : never
}

/** Wraps each store call on the main side, as a caller that tracks writes needs. */
export type BotItemsCallWrap = (op: BotItemsOp, run: () => Promise<unknown>) => Promise<unknown>

export function isBotItemsOp(op: string): op is BotItemsOp {
  return BOT_ITEMS_OPS.some((entry) => entry === op)
}

/** Runs one call the client sent; `BotItemsRemote` gives each op its own method's arguments. */
export function callBotItemsOp(
  store: BotItemsStore,
  op: BotItemsOp,
  args: readonly unknown[]
): unknown {
  const method: (...args: never[]) => unknown = store[op]
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the args crossed the worker boundary from a BotItemsRemote call of this same op.
  return method.apply(store, args as never[])
}
