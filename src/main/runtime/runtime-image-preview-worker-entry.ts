import { parentPort, workerData } from 'node:worker_threads'
import { shrinkImagePreview } from './runtime-image-preview-codec'

async function main(): Promise<void> {
  if (!parentPort) throw new Error('Image preview requires a worker')
  const result = await shrinkImagePreview(Buffer.from(workerData.bytes), workerData.maxBytes)
  parentPort.postMessage(result)
}

void main()
