// The work store's calls the bots DB worker answers, their async shape on the main side, and the
// store's file. Each call is one request; each write is one statement or transaction in the worker.
import { join } from 'node:path'
import type { BotWorkStore } from './bot-work-store'

export const BOT_WORK_OPS = [
  'live',
  'addressRows',
  'liveRows',
  'recentClosedRows',
  'isOpen',
  'bind',
  'close',
  'makeCurrent'
] as const satisfies readonly (keyof BotWorkStore)[]

export type BotWorkOp = (typeof BOT_WORK_OPS)[number]

/** The store as the main side reaches it: every call answered by the worker. */
export type BotWorkRemote = {
  [K in BotWorkOp]: BotWorkStore[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<R>
    : never
}

export function botWorkStoreFile(userDataPath: string): string {
  return join(userDataPath, 'bot-work.sqlite')
}

export function isBotWorkOp(op: string): op is BotWorkOp {
  return BOT_WORK_OPS.some((entry) => entry === op)
}

/** Runs one call the client sent; `BotWorkRemote` gives each op its own method's arguments. */
export function callBotWorkOp(
  store: BotWorkStore,
  op: BotWorkOp,
  args: readonly unknown[]
): unknown {
  const method: (...args: never[]) => unknown = store[op]
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the args crossed the worker boundary from a BotWorkRemote call of this same op.
  return method.apply(store, args as never[])
}

/** A store opened in this process (the CLI's eval, off Electron main), behind the same async shape. */
export function inProcessBotWork(store: () => BotWorkStore): BotWorkRemote {
  const remote = Object.fromEntries(
    BOT_WORK_OPS.map((op) => [op, async (...args: unknown[]) => callBotWorkOp(store(), op, args)])
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each op forwards its own arguments to the store method of that name.
  return remote as unknown as BotWorkRemote
}
