import { parentPort, workerData } from 'node:worker_threads'
import { installWorkerSendLedger } from '../../../worker-threads/worker-send-ledger'
import { createCodexRolloutHistoryReferences } from './codex-rollout-history-references'
import type {
  CodexRolloutReferencesRequest,
  CodexRolloutReferencesResponse,
  CodexRolloutReferencesWorkerData
} from './codex-rollout-history-references-protocol'

installWorkerSendLedger('orca-codex-rollout-references')

// Listing and diffing archive-sized folders before each deletion stays off Electron main.

if (!parentPort) {
  throw new Error('Codex rollout references worker must run with a parent port.')
}
const port = parentPort
const data: Partial<CodexRolloutReferencesWorkerData> | null = workerData
const cachePath = data?.cachePath
if (typeof cachePath !== 'string') {
  throw new Error('Codex rollout references worker needs its cache path.')
}
const controller = new AbortController()
const references = createCodexRolloutHistoryReferences(cachePath, controller.signal)

async function run(request: Exclude<CodexRolloutReferencesRequest, { op: 'abort' }>) {
  switch (request.op) {
    case 'prepare':
      return references.prepare(request.homes)
    case 'refresh':
      return references.refresh(request.homes)
    case 'refreshBlocked':
      return references.refreshBlocked(request.homes)
    case 'isReferenced':
      return references.isReferenced(request.rolloutId)
    case 'forget':
      return references.forget(request.rolloutId, request.paths)
    case 'save':
      await references.save()
      return undefined
  }
}

// One at a time, in order: a refresh must see every earlier forget.
let queue = Promise.resolve()
port.on('message', (request: CodexRolloutReferencesRequest) => {
  if (request.op === 'abort') {
    controller.abort()
    return
  }
  queue = queue.then(async () => {
    let response: CodexRolloutReferencesResponse
    try {
      response = { id: request.id, ok: true, value: await run(request) }
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error))
      response = { id: request.id, ok: false, name: failure.name, message: failure.message }
    }
    port.postMessage(response)
  })
})
