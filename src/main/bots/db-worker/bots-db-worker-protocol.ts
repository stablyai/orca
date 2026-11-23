// Electron-free: shared by the bots DB worker and its client. Requests are namespaced by store, so
// another bot store (bot-work.sqlite next) joins by adding its name and op table.

export const BOTS_DB_STORES = ['items', 'feishu'] as const

export type BotsDbStoreName = (typeof BOTS_DB_STORES)[number]

export type BotsDbWorkerRequest = {
  id: number
  store: BotsDbStoreName
  /** The store's file: one per profile. */
  path: string
  op: string
  args: unknown[]
}

export type BotsDbWorkerResponse =
  | { id: number; ok: true; value: unknown }
  /** `code` and `data` carry a store's own refusal (an item error) to the caller. */
  | { id: number; ok: false; error: string; code?: string; data?: unknown }
