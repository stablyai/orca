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

// Worker-only, Electron-free imports keep inline CreateProcessW stalls off main; the client dispatches serially (#11161).

if (!parentPort) {
  throw new Error('Port scan command worker must run with a parent port.')
}
const port = parentPort

process.once('exit', killActivePortScanCommands)

async function handleRequest(request: PortScanCommandRequest): Promise<PortScanCommandResponse> {
  try {
    const { stdout, spawnMs } = await runPortScanCommandInProcess(
      request.command,
      request.args,
      request.darwinOperation
    )
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
      // Clone failure must reply promptly rather than strand the client until its deadline.
      port.postMessage({
        id: request.id,
        ok: false,
        timedOut: false,
        error: 'Port scan command result could not be serialized.'
      })
    }
  })
})
