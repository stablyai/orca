import { parentPort, workerData } from 'node:worker_threads'
import { installWorkerSendLedger } from '../../../worker-threads/worker-send-ledger'
import { serializedWorkerReplyBytes } from '../../../utility-worker-host/utility-worker-reply-size'
import { isAgentSessionRefusalError } from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import { importClaudeTranscript } from './journal-claude-import'
import {
  ClaudeImportGrowthError,
  ClaudeImportResourceError
} from './journal-claude-import-resource-error'
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
let source: Pick<Awaited<ReturnType<typeof importClaudeTranscript>>, 'verify' | 'close'> | undefined
let pages: IterableIterator<Uint8Array> | undefined
let requests = importClaudeTranscript({ ...work, signal: controller.signal }).then(
  ({ items, sourceEmpty, identity, verify, close }) => {
    source = { verify, close }
    if (items.length) {
      pages = claudeImportPages(items)
    }
    send({ kind: 'imported', header: { count: items.length, sourceEmpty, identity } })
  },
  (error: unknown) => send(failure(error))
)

port.on('message', (request: ClaudeImportWorkerRequest) => {
  if (request.kind === 'close') {
    controller.abort()
  }
  requests = requests.then(async () => {
    try {
      if (request.kind === 'close') {
        pages = undefined
        await source?.close()
        source = undefined
        send({ kind: 'closed' })
      } else if (request.kind === 'verify') {
        if (!source) {
          throw new ClaudeImportResourceError('Claude history source is unavailable.')
        }
        send({ kind: 'verified', version: await source.verify() })
      } else {
        const next = pages?.next()
        if (next?.done === false) {
          send({ kind: 'page', bytes: next.value })
        } else {
          pages = undefined
          send({ kind: 'finished' })
        }
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
  if (error instanceof ClaudeImportGrowthError) {
    return { kind: 'growth', growth: error.growth }
  }
  if (error instanceof ClaudeImportResourceError) {
    return { kind: 'resource', message: error.message }
  }
  if (isAgentSessionRefusalError(error)) {
    return { kind: 'refusal', refusal: error.refusal }
  }
  return { kind: 'failed', message: error instanceof Error ? error.message : String(error) }
}
