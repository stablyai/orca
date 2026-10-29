import { parentPort } from 'node:worker_threads'
import { readDetectionDirectory } from './command-path-directory'
import type {
  DetectionDirectoryRequest,
  DetectionDirectoryResponse
} from './command-path-directory-worker-protocol'

if (!parentPort) {
  throw new Error('Detection directory worker must run with a parent port.')
}
const port = parentPort

port.on('message', (request: DetectionDirectoryRequest) => {
  void readDetectionDirectory(request.dir).then((names) => {
    const response: DetectionDirectoryResponse = { id: request.id, names }
    port.postMessage(response)
  })
})
