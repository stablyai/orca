import { parentPort } from 'node:worker_threads'
import { installWorkerSendLedger } from '../../../worker-threads/worker-send-ledger'
import { runCodexAccountCopiesRequest } from './codex-account-copies'
import type {
  CodexAccountCopiesRequest,
  CodexAccountCopiesResponse
} from './codex-account-copies-worker-protocol'

installWorkerSendLedger('orca-codex-account-copies')

// Reading tens of GB of old copies stays off Electron main.
if (!parentPort) {
  throw new Error('Codex account copies worker must run with a parent port.')
}
const port = parentPort

port.on('message', (request: CodexAccountCopiesRequest) => {
  void runCodexAccountCopiesRequest(request)
    .catch((error: unknown): CodexAccountCopiesResponse => ({
      ok: false,
      message: error instanceof Error ? error.message : String(error)
    }))
    .then((response) => port.postMessage(response))
})
