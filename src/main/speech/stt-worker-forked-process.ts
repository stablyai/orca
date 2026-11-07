import { fork } from 'node:child_process'
import { getSttWorkerPath } from './stt-worker-paths'
import {
  logSttWorkerStderr,
  SttWorkerChildProcess,
  type SttWorkerProcess
} from './stt-worker-process'

/** For orcad, which has no Electron utility processes. */
export function spawnSttForkedProcess(): SttWorkerProcess {
  const child = fork(getSttWorkerPath(), [], {
    // Structured clone keeps feed audio a Float32Array.
    serialization: 'advanced',
    execArgv: [],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    ...(process.platform === 'win32' ? { windowsHide: true } : {})
  })
  const worker = new SttWorkerChildProcess({
    // The callback swallows sends that race the child's exit; exit reports the failure.
    send: (message) => child.connected && child.send(message, () => undefined),
    kill: () => child.kill('SIGKILL')
  })
  logSttWorkerStderr(child.stderr)
  child.on('message', (message) => worker.receiveMessage(message))
  child.on('error', (error) => worker.receiveError(error))
  // A failed spawn can emit close without exit.
  child.on('exit', (code) => worker.receiveExit(code))
  child.on('close', (code) => worker.receiveExit(code))
  return worker
}
