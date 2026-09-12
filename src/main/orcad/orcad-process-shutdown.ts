import process from 'node:process'
import {
  installOrcadStopRequestListener,
  type OrcadStopRequestListener
} from './orcad-stop-request-listener'
import type { OrcadManagedStopRequestContext } from './orcad-managed-stop-request'

export const ORCAD_EXIT_OK = 0
export const ORCAD_EXIT_FAILED = 1
export const ORCAD_EXIT_CONFIGURATION = 78
export const ORCAD_SHUTDOWN_DEADLINE_MS = 15_000

export function installOrcadProcessShutdown(
  handle: { stop(): Promise<void> },
  installRoot: string,
  managedStop: OrcadManagedStopRequestContext
): void {
  let stopping = false
  const listeners: OrcadStopRequestListener[] = []
  const shutdown = (signal: NodeJS.Signals | 'ORCAD_STOP_REQUEST'): void => {
    if (stopping) {
      if (signal === 'ORCAD_STOP_REQUEST') {
        return
      }
      // A supervisor's second signal escalates; duplicate request delivery does not.
      console.error(`orcad: second ${signal} during shutdown — exiting immediately`)
      process.exit(ORCAD_EXIT_FAILED)
    }
    stopping = true
    for (const listener of listeners) {
      listener.close()
    }
    const deadline = setTimeout(() => {
      console.error(
        `orcad: shutdown after ${signal} exceeded ${ORCAD_SHUTDOWN_DEADLINE_MS}ms — exiting`
      )
      process.exit(ORCAD_EXIT_FAILED)
    }, ORCAD_SHUTDOWN_DEADLINE_MS)
    deadline.unref()
    handle
      .stop()
      .then(() => process.exit(ORCAD_EXIT_OK))
      .catch((error) => {
        console.error(`orcad: shutdown after ${signal} failed:`, error)
        process.exit(ORCAD_EXIT_FAILED)
      })
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  // Legacy requests remain available for process-only restarts, never bound decommission proof.
  for (const options of [{ installRoot, managedStop }, { installRoot }]) {
    const listener = installOrcadStopRequestListener(() => shutdown('ORCAD_STOP_REQUEST'), options)
    listeners.push(listener)
    if (stopping) {
      listener.close()
      break
    }
  }
}
