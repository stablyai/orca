// The import spool is synchronous SQLite; it runs here so the host's event loop stays free.
import { parentPort, workerData } from 'node:worker_threads'
import { isAgentSessionRefusalError } from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import { installWorkerSendLedger } from '../../../worker-threads/worker-send-ledger'
import { importClaudeTranscript } from './journal-claude-import'
import { ClaudeImportResourceError } from './journal-claude-import-resource-error'
import type {
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
port.on('message', (request: ClaudeImportWorkerRequest) => {
  if (request.kind === 'abort') {
    controller.abort()
  }
})

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
  (result) => {
    const response: ClaudeImportWorkerResponse = { kind: 'imported', result }
    port.postMessage(response)
  },
  (error: unknown) => port.postMessage(failure(error))
)
