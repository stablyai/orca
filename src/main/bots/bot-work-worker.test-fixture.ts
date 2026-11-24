// The work store through the bots DB worker's real client, queue and handler, on a real file.
import { inProcessWorker } from '../worker-threads/in-process-worker.test-fixture'
import type { BotWorkRemote } from './bot-work-ops'
import { BotsDbWorkerClient } from './db-worker/bots-db-worker-client'
import { closeBotsDbStores, handleBotsDbRequest } from './db-worker/bots-db-worker-entry'

export function workerBotWork(path: string): { store: BotWorkRemote; dispose: () => void } {
  const client = new BotsDbWorkerClient(inProcessWorker(handleBotsDbRequest).factory)
  return {
    store: client.work(path),
    dispose: () => {
      client.dispose()
      closeBotsDbStores()
    }
  }
}
