import { parentPort, workerData } from 'node:worker_threads'
import { installWorkerSendLedger } from '../../../worker-threads/worker-send-ledger'
import { serializedWorkerReplyBytes } from '../../../utility-worker-host/utility-worker-reply-size'
import { isAgentSessionRefusalError } from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import { importClaudeTranscript } from './journal-claude-import'
import { ClaudeImportResourceError } from './journal-claude-import-resource-error'
import { claudeImportPages } from './journal-claude-import-pages'
import {
  CLAUDE_IMPORT_PAGE_BYTES,
  type ClaudeImportWork,
  type ClaudeImportWorkerRequest,
  type ClaudeImportWorkerResponse
} from './journal-claude-import-worker-protocol'

installWorkerSendLedger('orca-claude-history-import')

if (!parentPort) {
  throw new Error('Claude history import worker requires a parent port.')
}
const port = parentPort
const controller = new AbortController()
const work: ClaudeImportWork = workerData
const preparation = importClaudeTranscript({ ...work, signal: controller.signal })
let pages: IterableIterator<Uint8Array> | undefined
let requests = preparation.then(
  ({ items, sourceEmpty }) => {
    pages = claudeImportPages(items)
    send({ kind: 'imported', header: { count: items.length, sourceEmpty } })
  },
  (error: unknown) => send(failure(error))
)

port.on('message', (request: ClaudeImportWorkerRequest) => {
  if (request.kind === 'close') {
    controller.abort()
  }
  requests = requests.then(async () => {
    try {
      const result = await preparation
      if (request.kind === 'close') {
        pages = undefined
        await result.close()
        send({ kind: 'closed' })
      } else if (request.kind === 'verify') {
        send({ kind: 'verified', version: await result.verify() })
      } else {
        const next = pages?.next()
        send(next?.done === false ? { kind: 'page', bytes: next.value } : { kind: 'finished' })
      }
    } catch (error) {
      send(failure(error))
    }
  })
})

function send(response: ClaudeImportWorkerResponse): void {
  if (
    response.kind !== 'page' &&
    serializedWorkerReplyBytes(response).framed > CLAUDE_IMPORT_PAGE_BYTES
  ) {
    port.postMessage({ kind: 'resource', message: 'A Claude import reply exceeds the page limit.' })
  } else {
    port.postMessage(response)
  }
}

function failure(error: unknown): ClaudeImportWorkerResponse {
  if (error instanceof ClaudeImportResourceError) {
    return { kind: 'resource', message: error.message }
  }
  if (isAgentSessionRefusalError(error)) {
    return { kind: 'refusal', refusal: error.refusal }
  }
  return { kind: 'failed', message: error instanceof Error ? error.message : String(error) }
}
