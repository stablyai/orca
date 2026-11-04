import { parentPort } from 'node:worker_threads'
import { surfaceExecutorAdmissionSchema } from '../../shared/workspace-surfaces/surface-executor-contract'
import { SurfaceExecutorIntentReader } from './surface-executor-intent'

if (!parentPort) {
  throw new Error('Surface execution reader requires its worker owner')
}
const port = parentPort
const reader = new SurfaceExecutorIntentReader()
port.on('close', () => reader.close())
port.on('message', (message: { id: number; admission: unknown }) => {
  const admission = surfaceExecutorAdmissionSchema.safeParse(message.admission)
  let intent: ReturnType<SurfaceExecutorIntentReader['read']> = { kind: 'unreadable' }
  try {
    if (admission.success) {
      intent = reader.read(admission.data)
    }
  } catch {}
  port.postMessage({ id: message.id, intent })
})
