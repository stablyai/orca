import { parentPort } from 'node:worker_threads'
import { surfaceExecutorAdmissionSchema } from '../../shared/workspace-surfaces/surface-executor-contract'
import { readSurfaceExecutorIntent } from './surface-executor-intent'

if (!parentPort) {
  throw new Error('Surface execution reader requires its worker owner')
}
const port = parentPort
port.on('message', (message: { id: number; admission: unknown }) => {
  const admission = surfaceExecutorAdmissionSchema.safeParse(message.admission)
  let intent: ReturnType<typeof readSurfaceExecutorIntent> = { kind: 'unreadable' }
  try {
    if (admission.success) {
      intent = readSurfaceExecutorIntent(admission.data)
    }
  } catch {}
  port.postMessage({ id: message.id, intent })
})
