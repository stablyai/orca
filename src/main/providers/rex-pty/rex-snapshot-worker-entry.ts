import { lazyZodSchema } from '../../../shared/schema/lazy-zod-schema'
import { parentPort, workerData } from 'node:worker_threads'
import { z } from 'zod'
import { decodeRexGhosttySnapshot } from './rex-ghostty-decoder'
import { installWorkerSendLedger } from '../../worker-threads/worker-send-ledger'

installWorkerSendLedger('orca-rex-snapshot')
if (!parentPort) {
  throw new Error('Rex snapshot decoder requires a worker')
}
const port = parentPort
const jobSchema = lazyZodSchema(() =>
  z.object({
    wasm: z.instanceof(Uint8Array),
    snapshot: z.instanceof(Uint8Array)
  })
)
async function run(): Promise<void> {
  const job = jobSchema.parse(workerData)
  const result = await decodeRexGhosttySnapshot(Buffer.from(job.wasm), Buffer.from(job.snapshot))
  port.postMessage({ ok: true, result })
}
void run()
  .catch(() => port.postMessage({ ok: false }))
  .finally(() => port.close())
