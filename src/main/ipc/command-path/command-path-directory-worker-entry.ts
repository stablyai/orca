import { parentPort } from 'node:worker_threads'
import { readDetectionDirectory, readInstallSubdirectories } from './command-path-directory'
import type {
  DetectionDirectoryRequest,
  DetectionDirectoryResponse
} from './command-path-directory-worker-protocol'
import { installWorkerSendLedger } from '../../worker-threads/worker-send-ledger'

installWorkerSendLedger('orca-command-path-directory')

if (!parentPort) {
  throw new Error('Detection directory worker must run with a parent port.')
}
const port = parentPort

port.on('message', async (request: DetectionDirectoryRequest) => {
  const listing = await (request.mode === 'install'
    ? readInstallSubdirectories(request.dir)
    : readDetectionDirectory(request.dir))
  const response: DetectionDirectoryResponse = { id: request.id, listing }
  port.postMessage(response)
})
