// The bots DB worker: every bot SQLite store's SQL runs here, off the runtime's thread. One request
// at a time (the client serializes them), each answered by one store call.
import { parentPort } from 'node:worker_threads'
import { BotItemError } from '../bot-item-error'
import { callBotItemsOp, isBotItemsOp } from '../bot-items-ops'
import { BotItemsStore } from '../bot-items-store'
import type {
  BotsDbStoreName,
  BotsDbWorkerRequest,
  BotsDbWorkerResponse
} from './bots-db-worker-protocol'
import { installWorkerSendLedger } from '../../worker-threads/worker-send-ledger'

installWorkerSendLedger('orca-bots-db')

/** A store the worker opened: runs one named call, or answers that it has no such call. */
type OpenStore = {
  call: (op: string, args: readonly unknown[]) => { found: boolean; value?: unknown }
  dispose: () => void
}

function openItems(path: string): OpenStore {
  const store = BotItemsStore.open(path)
  return {
    call: (op, args) =>
      isBotItemsOp(op) ? { found: true, value: callBotItemsOp(store, op, args) } : { found: false },
    dispose: () => store.dispose()
  }
}

/** Each store this worker hosts, by the name requests carry. */
const STORES: Record<BotsDbStoreName, (path: string) => OpenStore> = {
  items: openItems
}

const opened = new Map<string, OpenStore>()

function storeFor(name: BotsDbStoreName, path: string): OpenStore {
  const key = `${name}\0${path}`
  let store = opened.get(key)
  if (!store) {
    store = STORES[name](path)
    opened.set(key, store)
  }
  return store
}

/** Exported for tests, which run it in process behind the same async boundary. */
export function handleBotsDbRequest(request: BotsDbWorkerRequest): BotsDbWorkerResponse {
  try {
    if (!Object.hasOwn(STORES, request.store)) {
      throw new Error(`The bots DB worker has no ${request.store} store.`)
    }
    const result = storeFor(request.store, request.path).call(request.op, request.args)
    if (!result.found) {
      throw new Error(`The bots DB worker has no ${request.store}.${request.op}.`)
    }
    return { id: request.id, ok: true, value: result.value }
  } catch (error) {
    if (error instanceof BotItemError) {
      return { id: request.id, ok: false, error: error.message, code: error.code, data: error.data }
    }
    return {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

/** Closes every open file; the next request reopens. */
export function closeBotsDbStores(): void {
  for (const store of opened.values()) {
    store.dispose()
  }
  opened.clear()
}

const port = parentPort
if (port) {
  port.on('message', (request: BotsDbWorkerRequest) => {
    port.postMessage(handleBotsDbRequest(request))
  })
  port.on('close', closeBotsDbStores)
}
