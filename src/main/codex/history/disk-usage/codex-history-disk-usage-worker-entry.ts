import { parentPort } from 'node:worker_threads'
import { measureCodexHistoryDiskUsage } from './codex-history-disk-usage-walk'
import type {
  CodexHistoryDiskUsageWorkerRequest,
  CodexHistoryDiskUsageWorkerResponse
} from './codex-history-disk-usage-worker-protocol'
import { installWorkerSendLedger } from '../../../worker-threads/worker-send-ledger'

installWorkerSendLedger('orca-codex-history-disk-usage')

if (!parentPort) {
  throw new Error('Codex history disk usage worker requires a parent port.')
}
const port = parentPort

port.on('message', (request: CodexHistoryDiskUsageWorkerRequest) => {
  let response: CodexHistoryDiskUsageWorkerResponse
  try {
    response = {
      id: request.id,
      ok: true,
      usage: measureCodexHistoryDiskUsage(request.roots, request.budget)
    }
  } catch (error) {
    response = {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
  port.postMessage(response)
})
