import type { WorkerWatchdogSentinel } from './worker-watchdog-protocol'
import type { WorkerWatchdogRuntimeDeps } from './worker-watchdog-runtime-deps'
import { readWorkerWatchdogRequestFile } from './worker-watchdog-sentinel-file'

export async function runWorkerWatchdogEntry(
  runWatchdog: (
    request: unknown,
    deps?: WorkerWatchdogRuntimeDeps
  ) => Promise<WorkerWatchdogSentinel>,
  argv = process.argv
): Promise<void> {
  const requestPath = argv[2]
  if (!requestPath) {
    throw new Error('Usage: worker-watchdog-entry <request-json-path>')
  }
  const request = readWorkerWatchdogRequestFile(requestPath)
  await runWatchdog(request, {
    onStarted: (receipt: unknown) => process.stdout.write(`${JSON.stringify(receipt)}\n`)
  })
}
