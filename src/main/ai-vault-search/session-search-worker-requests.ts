import { parentPort } from 'node:worker_threads'
import type {
  SearchWorkerCommand,
  SearchWorkerRequest,
  SearchWorkerResponse
} from './worker/session-search-worker-protocol'

export function listenForSessionSearchRequests(
  execute: (request: SearchWorkerRequest) => Promise<SearchWorkerResponse>,
  pending: () => boolean,
  failed: (command: SearchWorkerCommand) => void
): void {
  let lane = Promise.resolve()
  parentPort?.on('message', (request: SearchWorkerRequest) => {
    lane = lane.then(async () => {
      try {
        const response = await execute(request)
        response.catalogPending = pending()
        parentPort?.postMessage(response)
      } catch (error) {
        const command = request.command
        failed(command)
        parentPort?.postMessage({
          id: request.id,
          accepted: false,
          failure:
            command.op === 'begin' ||
            command.op === 'batch' ||
            command.op === 'read-batch' ||
            command.op === 'finish'
              ? 'write'
              : undefined,
          error: error instanceof Error ? error.message : 'Session search failed'
        })
      }
    })
  })
}
