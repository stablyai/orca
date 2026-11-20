import { parentPort, workerData } from 'node:worker_threads'
import { setFdClosingExec } from '@orca/process-host/fd-closing-exec-launch'
import { serveWorkerThreadChildProcesses } from './worker-thread-child-process-server'
import { installWorkerSendLedger } from '../worker-threads/worker-send-ledger'

installWorkerSendLedger('orca-child-process-spawner')

if (!parentPort) {
  throw new Error('Worker-thread child process host must run with a parent port.')
}
// Set only when this worker runs in main (its utility host is unavailable): it shares main's fds.
const helper: unknown =
  typeof workerData === 'object' && workerData !== null && 'fdClosingHelper' in workerData
    ? workerData.fdClosingHelper
    : undefined
if (typeof helper === 'string') {
  setFdClosingExec(helper)
}
serveWorkerThreadChildProcesses(parentPort, { closeInheritedFds: typeof helper === 'string' })
