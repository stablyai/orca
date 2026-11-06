import { parentPort, workerData } from 'node:worker_threads'
import { decodeLegacyTranscriptImport } from './journal-legacy-import-decode'
import type {
  LegacyImportValidation,
  LegacyImportWorkerMessage,
  LegacyTranscriptImportRequest
} from './journal-legacy-import-worker-protocol'

if (!parentPort) {
  throw new Error('History import requires a parent port')
}
const port = parentPort
const send = (message: LegacyImportWorkerMessage) => port.postMessage(message)

void decodeLegacyTranscriptImport(
  workerData as LegacyTranscriptImportRequest,
  (observed) =>
    new Promise<void>((resolve, reject) => {
      port.once('message', (reply: LegacyImportValidation) => {
        if (reply.ok) {
          resolve()
        } else {
          reject(new Error(reply.error))
        }
      })
      send({ type: 'validate-source', observed })
    })
)
  .then(
    (result) => send({ type: 'result', result }),
    (error: unknown) =>
      send({
        type: 'result',
        result: { ok: false, error: error instanceof Error ? error.message : String(error) }
      })
  )
  .finally(() => port.close())
