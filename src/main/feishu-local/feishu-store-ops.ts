import type { BotsDbWorkerClient } from '../bots/db-worker/bots-db-worker-client'
import type { FeishuInbox } from './feishu-inbox'
const OPS = [
  'bindings',
  'add',
  'remove',
  'pair',
  'accept',
  'next',
  'admitted',
  'review',
  'needsReview',
  'mayPost'
] as const satisfies readonly (keyof FeishuInbox)[]
type Op = (typeof OPS)[number]
export const isFeishuOp = (op: string): op is Op => OPS.some((allowed) => allowed === op)
export type FeishuStore = {
  [K in Op]: (...args: Parameters<FeishuInbox[K]>) => Promise<ReturnType<FeishuInbox[K]>>
}
export function feishuStore(client: BotsDbWorkerClient, path: string): FeishuStore {
  const remote = Object.fromEntries(
    OPS.map((op) => [op, (...args: unknown[]) => client.call('feishu', path, op, args)])
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each operation forwards its own argument tuple and returns that worker method's result.
  return remote as FeishuStore
}
