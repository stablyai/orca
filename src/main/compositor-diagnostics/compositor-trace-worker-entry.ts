import { parentPort, workerData } from 'node:worker_threads'
import {
  CompositorTraceBudgetError,
  CompositorTraceValidationError,
  createCompositorTraceParser
} from './compositor-trace-parser'
import type { CompositorParserRequest } from './compositor-trace-observations'

const parser = createCompositorTraceParser(workerData.pids)
parentPort?.on('message', (message: CompositorParserRequest) => {
  try {
    if (message.end) {
      parentPort?.postMessage({ id: message.id, ...parser.finish() })
      parentPort?.close()
    } else if (message.chunk) {
      parser.write(message.chunk)
      parentPort?.postMessage({ id: message.id, ready: true })
    }
  } catch (error) {
    parentPort?.postMessage({
      id: message.id,
      ok: false,
      reason:
        error instanceof CompositorTraceBudgetError
          ? 'parser-budget'
          : error instanceof SyntaxError || error instanceof CompositorTraceValidationError
            ? 'trace-invalid'
            : 'parser-unavailable'
    })
    parentPort?.close()
  }
})
