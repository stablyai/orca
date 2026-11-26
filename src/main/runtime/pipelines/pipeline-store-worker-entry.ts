import { parentPort } from 'node:worker_threads'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { PipelineStore } from './pipeline-store'
import {
  callPipelineStoreMethod,
  PIPELINE_STORE_OPS,
  PIPELINE_TEMPLATE_OPS,
  PIPELINE_REQUEST_OPS,
  PIPELINE_DECISION_OPS
} from './pipeline-store-port'
import {
  PIPELINE_STORE_GROUPS,
  type PipelineStoreWorkerRequest,
  type PipelineStoreWorkerResponse
} from './pipeline-store-worker-protocol'
import type { RuntimeClientEvent } from '../../../shared/remote-runtime/session-graph/runtime-client-events'
import { installWorkerSendLedger } from '../../worker-threads/worker-send-ledger'

installWorkerSendLedger('orca-pipeline-store')
const stores = new Map<string, PipelineStore>()
let events: RuntimeClientEvent[] = []

export function handlePipelineStoreRequest(
  request: PipelineStoreWorkerRequest
): PipelineStoreWorkerResponse {
  events = []
  try {
    if (!PIPELINE_STORE_GROUPS.includes(request.group)) {
      throw new Error('pipeline_store_operation_invalid')
    }
    let store = stores.get(request.file)
    if (!store) {
      if (request.file !== ':memory:') {
        mkdirSync(dirname(request.file), { recursive: true, mode: 0o700 })
      }
      store = new PipelineStore(request.file, (event) => events.push(event))
      stores.set(request.file, store)
    }
    let value: unknown
    switch (request.group) {
      case 'runs':
        value = callPipelineStoreMethod(store, PIPELINE_STORE_OPS, request.op, request.args)
        if (request.op === 'close') {
          stores.delete(request.file)
        }
        break
      case 'templates':
        value = callPipelineStoreMethod(
          store.templatesV2,
          PIPELINE_TEMPLATE_OPS,
          request.op,
          request.args
        )
        break
      case 'requests':
        value = callPipelineStoreMethod(
          store.ownerRequestsV2,
          PIPELINE_REQUEST_OPS,
          request.op,
          request.args
        )
        break
      case 'decisions':
        value = callPipelineStoreMethod(
          store.decisionsV2,
          PIPELINE_DECISION_OPS,
          request.op,
          request.args
        )
        break
    }
    return { id: request.id, ok: true, value, events }
  } catch (error) {
    return {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      events
    }
  }
}

export function closePipelineWorkerStores(): void {
  for (const store of stores.values()) {
    store.close()
  }
  stores.clear()
}
const port = parentPort
if (port) {
  port.on('message', (request: PipelineStoreWorkerRequest) => {
    port.postMessage(handlePipelineStoreRequest(request))
  })
  port.on('close', closePipelineWorkerStores)
}
