import { parentPort } from 'node:worker_threads'
import type {
  PluginSourceTranspileRequest,
  PluginSourceTranspileResponse,
  PluginSourceTranspileWorkerReady
} from './source-transpilation/plugin-source-transpile-protocol'
import { transpilePluginSource } from './source-transpilation/plugin-source-transpiler'
import { installWorkerSendLedger } from '../../worker-threads/worker-send-ledger'

installWorkerSendLedger('orca-plugin-transpile')

// Electron-free: transpiling a large plugin file must never block the main process.

if (!parentPort) {
  throw new Error('Plugin source transpile worker must run with a parent port.')
}
const port = parentPort

port.on('message', (request: PluginSourceTranspileRequest) => {
  const response: PluginSourceTranspileResponse = {
    id: request.id,
    result: transpilePluginSource(request.relativePath, request.source)
  }
  port.postMessage(response)
})

const ready: PluginSourceTranspileWorkerReady = { ready: true }
port.postMessage(ready)
