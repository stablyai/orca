import { parentPort } from 'node:worker_threads'
import { prepareAgentImageFile } from './agent-image-fit'
import type { AgentImageFitRequest, AgentImageFitResponse } from './agent-image-fit-protocol'
import { installWorkerSendLedger } from '../../worker-threads/worker-send-ledger'

installWorkerSendLedger('orca-agent-image-fit')
if (!parentPort) {
  throw new Error('Image fitting requires a worker port')
}
const port = parentPort
port.on('message', (request: AgentImageFitRequest) => {
  void prepareAgentImageFile(request.path, request.outputDirectory).then(
    (result) => {
      const response: AgentImageFitResponse = { id: request.id, ok: true, ...result }
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
