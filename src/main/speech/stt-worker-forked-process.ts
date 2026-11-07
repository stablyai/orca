import { forkProcess } from '@orca/process-host/fork-process'
import { getSttWorkerPath } from './stt-worker-paths'
import {
  logSttWorkerStderr,
  SttWorkerChildProcess,
  type SttWorkerProcess
} from './stt-worker-process'

/** For orcad, which has no Electron utility processes. */
export function spawnSttForkedProcess(): SttWorkerProcess {
  const child = forkProcess({
    modulePath: getSttWorkerPath(),
    // Structured clone keeps feed audio a Float32Array.
    serialization: 'advanced',
    execArgv: [],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  })
  const kill = (): void => {
    child.kill('SIGKILL')
  }
  const worker = new SttWorkerChildProcess({
    // The callback swallows sends that race the child's exit; exit reports the failure.
    send: (message) => child.connected && child.send(message, () => undefined),
    kill
  })
  // A child stuck in native code can't hear the IPC disconnect, so orcad's exit takes it down.
  process.once('exit', kill)
  child.once('close', () => process.off('exit', kill))
  logSttWorkerStderr(child.stderr)
  child.on('message', (message) => worker.receiveMessage(message))
  // Exit or close follows every failure that matters and reports it; unheard, 'error' would throw.
  child.on('error', () => undefined)
  // A failed spawn can emit close without exit.
  child.on('exit', (code) => worker.receiveExit(code))
  child.on('close', (code) => worker.receiveExit(code))
  return worker
}
