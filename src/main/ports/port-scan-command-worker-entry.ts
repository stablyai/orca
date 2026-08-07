import { parentPort } from 'node:worker_threads'
import {
  killActivePortScanCommands,
  runPortScanCommandInProcess
} from './port-scan-command-execution'
import {
  PortScanCommandTimeoutError,
  type PortScanCommandRequest,
  type PortScanCommandResponse
} from './port-scan-command-protocol'

// Why (#11161): process creation blocks the event loop that issues it. Running
// the port scan's probe commands on this worker thread keeps an EDR-hooked
// CreateProcessW off CrBrowserMain. The client dispatches one request at a
// time, so this loop stays serial; imports must remain electron-free.

if (!parentPort) {
  throw new Error('Port scan command worker must run with a parent port.')
}
const port = parentPort

process.once('exit', killActivePortScanCommands)

async function handleRequest(request: PortScanCommandRequest): Promise<PortScanCommandResponse> {
  try {
    const { stdout, spawnMs } = await runPortScanCommandInProcess(request.command, request.args)
    return { id: request.id, ok: true, stdout, spawnMs }
  } catch (err) {
    return {
      id: request.id,
      ok: false,
      timedOut: err instanceof PortScanCommandTimeoutError,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

port.on('message', (request: PortScanCommandRequest) => {
  void handleRequest(request).then((response) => {
    try {
      port.postMessage(response)
    } catch {
      // A non-cloneable result would otherwise post nothing and leave the client
      // waiting out its deadline; fail that request fast instead.
      port.postMessage({
        id: request.id,
        ok: false,
        timedOut: false,
        error: 'Port scan command result could not be serialized.'
      })
    }
  })
})
