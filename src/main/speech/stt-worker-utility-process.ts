import { utilityProcess } from 'electron'
import { getSttWorkerPath } from './stt-worker-paths'
import {
  logSttWorkerStderr,
  STT_UTILITY_PROCESS_NAME,
  SttWorkerChildProcess,
  type SttWorkerProcess
} from './stt-worker-process'

/** A native crash or hang in the recognizer stays out of the app's main process. */
export function spawnSttUtilityProcess(): SttWorkerProcess {
  const child = utilityProcess.fork(getSttWorkerPath(), [], {
    serviceName: STT_UTILITY_PROCESS_NAME,
    stdio: ['ignore', 'ignore', 'pipe']
  })
  const worker = new SttWorkerChildProcess({
    send: (message) => child.postMessage(message),
    sendPort: (message, port) => child.postMessage(message, [port]),
    kill: () => child.kill()
  })
  logSttWorkerStderr(child.stderr)
  child.on('message', (message) => worker.receiveMessage(message))
  // A V8 fatal error is always followed by exit, which reports it; unheard, it would throw in main.
  child.on('error', () => undefined)
  child.on('exit', (code) => worker.receiveExit(code))
  return worker
}
