import { parentPort } from 'node:worker_threads'
import { serveWorkerThreadChildProcesses } from './worker-thread-child-process-server'

if (!parentPort) {
  throw new Error('Worker-thread child process host must run with a parent port.')
}
serveWorkerThreadChildProcesses(parentPort)
