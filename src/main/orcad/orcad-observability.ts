import process from 'node:process'
import {
  closeObservabilityOnExit,
  initObservability,
  shutdownObservability
} from '../observability'
import { getOrcadTraceFilePath } from '../observability/logs-directory'

/** Install before runtime startup; close after quit handlers so their spans reach disk. */
export function installOrcadObservability(): () => Promise<void> {
  initObservability({ traceFilePath: getOrcadTraceFilePath() })
  // Exits that skip normal cleanup still get the queued tail.
  process.once('exit', closeObservabilityOnExit)
  return () => {
    // An exit during the bounded shutdown flush still writes the queued tail.
    return shutdownObservability().finally(() => process.off('exit', closeObservabilityOnExit))
  }
}
