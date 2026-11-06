import { parentPort, workerData } from 'node:worker_threads'
import { decodeLegacyTranscriptImport } from './journal-legacy-import-decode'
import { transferLegacyImportItems } from './journal-legacy-import-transfer'
import type {
  LegacyImportWorkerReply,
  LegacyImportWorkerMessage,
  LegacyTranscriptImportRequest
} from './journal-legacy-import-worker-protocol'

if (!parentPort) {
  throw new Error('History import requires a parent port')
}
const port = parentPort
const send = (message: LegacyImportWorkerMessage) => port.postMessage(message)
const request = (message: LegacyImportWorkerMessage) =>
  new Promise<LegacyImportWorkerReply>((resolve) => {
    port.once('message', resolve)
    send(message)
  })

void decodeLegacyTranscriptImport(workerData as LegacyTranscriptImportRequest, async (observed) => {
  const reply = await request({ type: 'validate-source', observed })
  if (reply?.type !== 'validation') {
    throw new Error('Invalid history validation acknowledgement')
  }
  if (!reply.ok) {
    throw new Error(reply.error)
  }
})
  .then(async (result) => {
    if (!result.ok) {
      send({ type: 'result', result })
      return
    }
    const completed = await transferLegacyImportItems(result.items, async (batch) => {
      const reply = await request(batch)
      if (reply?.type !== 'credit' || reply.index !== batch.index) {
        throw new Error('Invalid history transfer acknowledgement')
      }
    })
    send({ type: 'result', result: { ok: true, sourceEmpty: result.sourceEmpty, ...completed } })
  })
  .catch((error: unknown) =>
    send({
      type: 'result',
      result: { ok: false, error: error instanceof Error ? error.message : String(error) }
    })
  )
  .finally(() => port.close())
