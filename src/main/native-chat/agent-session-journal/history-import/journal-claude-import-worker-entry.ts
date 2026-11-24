// The import spool is synchronous SQLite; it runs here so the host's event loop stays free.
import { parentPort, workerData } from 'node:worker_threads'
import { serialize } from 'node:v8'
import { isAgentSessionRefusalError } from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import { installWorkerSendLedger } from '../../../worker-threads/worker-send-ledger'
import { importClaudeTranscript } from './journal-claude-import'
import { ClaudeImportResourceError } from './journal-claude-import-resource-error'
import { claudeImportPages } from './journal-claude-import-pages'
import {
  CLAUDE_IMPORT_PAGE_BYTES,
  CLAUDE_IMPORT_REPLY_FRAMING_BYTES
} from './journal-claude-import-worker-protocol'
import type {
  ClaudeImportPage,
  ClaudeImportWork,
  ClaudeImportWorkerRequest,
  ClaudeImportWorkerResponse
} from './journal-claude-import-worker-protocol'

installWorkerSendLedger('orca-claude-history-import')

if (!parentPort) {
  throw new Error('Claude history import worker requires a parent port.')
}
const port = parentPort
const controller = new AbortController()
let pages: Generator<ClaudeImportPage> | undefined
port.on('message', (request: ClaudeImportWorkerRequest) => {
  if (request.kind === 'abort') {
    controller.abort()
  } else if (pages) {
    try {
      const next = pages.next()
      if (next.value && !next.done) {
        send(next.value)
      }
    } catch (error) {
      pages = undefined
      send(failure(error))
    }
  }
})

function send(response: ClaudeImportWorkerResponse): void {
  if (
    serialize(response).byteLength >
    CLAUDE_IMPORT_PAGE_BYTES - CLAUDE_IMPORT_REPLY_FRAMING_BYTES
  ) {
    port.postMessage({ kind: 'resource', message: 'A Claude import reply exceeds the page limit.' })
  } else {
    port.postMessage(response)
  }
}

function failure(error: unknown): ClaudeImportWorkerResponse {
  if (controller.signal.aborted) {
    return { kind: 'aborted' }
  }
  if (error instanceof ClaudeImportResourceError) {
    return { kind: 'resource', message: error.message }
  }
  if (isAgentSessionRefusalError(error)) {
    return { kind: 'refusal', refusal: error.refusal }
  }
  return { kind: 'failed', message: error instanceof Error ? error.message : String(error) }
}

const work: ClaudeImportWork = workerData
void importClaudeTranscript({ ...work, signal: controller.signal }).then(
  ({ items, savedKeys, retainedBytes: _retainedBytes, ...header }) => {
    pages = claudeImportPages({ items, savedKeys })
    send({ kind: 'imported', header })
  },
  (error: unknown) => send(failure(error))
)
