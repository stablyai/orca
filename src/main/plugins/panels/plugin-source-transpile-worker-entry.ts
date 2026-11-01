import { parentPort } from 'node:worker_threads'
import type {
  PluginSourceTranspileRequest,
  PluginSourceTranspileResponse
} from './plugin-source-transpile-protocol'
import { transpilePluginSource } from './plugin-source-transpiler'

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
