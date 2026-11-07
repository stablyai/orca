import { utilityProcess } from 'electron'
import { getSttWorkerPath } from './stt-worker-paths'
import {
  logSttWorkerStderr,
  SttWorkerChildProcess,
  type SttWorkerProcess
} from './stt-worker-process'

/** A native crash or hang in the recognizer stays out of the app's main process. */
export function spawnSttUtilityProcess(): SttWorkerProcess {
  const child = utilityProcess.fork(getSttWorkerPath(), [], {
    serviceName: 'Orca Speech',
    stdio: ['ignore', 'ignore', 'pipe']
  })
  // W1.4 seam: a renderer MessagePortMain can be posted to this child directly.
  const worker = new SttWorkerChildProcess({
    send: (message) => child.postMessage(message),
    kill: () => child.kill()
  })
  logSttWorkerStderr(child.stderr)
  child.on('message', (message) => worker.receiveMessage(message))
  // A V8 fatal error is always followed by exit, which reports it; unheard, it would throw in main.
  child.on('error', () => undefined)
  child.on('exit', (code) => worker.receiveExit(code))
  return worker
}
