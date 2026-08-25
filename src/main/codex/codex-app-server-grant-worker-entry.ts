import { isMainThread, parentPort, workerData } from 'node:worker_threads'
import {
  runCodexAppServerEntrySync,
  type CodexGrantWorkerRequest
} from './codex-app-server-grant-bridge'
import { isCodexAppServerUnsupportedError } from './codex-app-server-session'

const request = workerData as CodexGrantWorkerRequest

if (!isMainThread && parentPort) {
  try {
    parentPort.postMessage({
      ok: true,
      result: runCodexAppServerEntrySync(request.request, request.options)
    })
  } catch (error) {
    parentPort.postMessage({
      ok: false,
      errorName: error instanceof Error ? error.name : 'Error',
      message: error instanceof Error ? error.message : String(error),
      unsupported: isCodexAppServerUnsupportedError(error)
    })
  }
}
