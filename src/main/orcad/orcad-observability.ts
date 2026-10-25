import process from 'node:process'
import { flushObservability, initObservability, shutdownObservability } from '../observability'
import { getOrcadTraceFilePath } from '../observability/logs-directory'

/** Install before runtime startup; close after quit handlers so their spans reach disk. */
export function installOrcadObservability(): () => void {
  initObservability({ traceFilePath: getOrcadTraceFilePath() })
  // Exit handlers flush synchronously even when normal cleanup cannot run.
  process.once('exit', flushObservability)
  return () => {
    process.off('exit', flushObservability)
    void shutdownObservability()
  }
}
