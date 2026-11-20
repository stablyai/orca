import { parentPort } from 'node:worker_threads'
import { fitAgentImageFile } from './agent-image-fit'
import type { AgentImageFitRequest, AgentImageFitResponse } from './agent-image-fit-protocol'
import { installWorkerSendLedger } from '../../worker-threads/worker-send-ledger'

installWorkerSendLedger('orca-agent-image-fit')
if (!parentPort) {
  throw new Error('Image fitting requires a worker port')
}
const port = parentPort
port.on('message', (request: AgentImageFitRequest) => {
  void fitAgentImageFile(request.path, request.outputDirectory).then(
    (path) => {
      const response: AgentImageFitResponse = { id: request.id, ok: true, path }
      port.postMessage(response)
    },
    (error: unknown) => {
      const response: AgentImageFitResponse = {
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      }
      port.postMessage(response)
    }
  )
})
