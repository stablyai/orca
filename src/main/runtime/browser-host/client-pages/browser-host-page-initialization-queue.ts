import type { BrowserHostPagePartitionPreparation } from './browser-host-page-partition-preparation'
import type {
  Initialization,
  InitializationOutcome,
  InitializationQueue
} from './browser-host-page-initialization-records'

export function scheduleInitializationQueue(
  queues: Map<symbol, InitializationQueue>,
  token: symbol,
  queue: InitializationQueue,
  run: (operation: Initialization) => Promise<InitializationOutcome>,
  settle: (operation: Initialization, outcome: InitializationOutcome) => void
): void {
  if (queue.scheduled) {
    return
  }
  queue.scheduled = true
  queueMicrotask(() => {
    queue.scheduled = false
    if (queues.get(token) !== queue) {
      return
    }
    while (queue.active < 4 && queue.pending.length) {
      const operation = queue.pending.shift()!
      if (operation.detached || operation.record.operation !== operation) {
        continue
      }
      operation.running = true
      operation.executing = true
      queue.active += 1
      void run(operation).then((outcome) => settle(operation, outcome))
    }
    if (!queue.active && !queue.pending.length) {
      queues.delete(token)
    }
  })
}

/** Waiting for exact predecessor joins holds no shared execution permit. */
export function waitForInitializationPartition(
  operation: Initialization,
  preparation: BrowserHostPagePartitionPreparation,
  queues: Map<symbol, InitializationQueue>,
  schedule: (token: symbol, queue: InitializationQueue) => void
): void {
  operation.executing = false
  operation.phase = 'waiting'
  const { record, admission } = operation
  const queue = queues.get(admission.state.token)
  if (operation.running && queue) {
    queue.active -= 1
    operation.running = false
  }
  preparation.joined(admission.state, record)
  operation.removePreparation = preparation.wait(
    admission.state,
    record.browserProfileId,
    operation.executionHostKey!,
    () => {
      if (operation.detached || record.operation !== operation) {
        return
      }
      operation.removePreparation = undefined
      operation.phase = 'create'
      const readyQueue = initializationQueue(queues, admission.state.token)
      readyQueue.pending.push(operation)
      schedule(admission.state.token, readyQueue)
    },
    () => {}
  )
  if (queue) {
    schedule(admission.state.token, queue)
  }
}

export function initializationQueue(
  queues: Map<symbol, InitializationQueue>,
  token: symbol
): InitializationQueue {
  let queue = queues.get(token)
  if (!queue) {
    queue = { pending: [], active: 0, scheduled: false }
    queues.set(token, queue)
  }
  return queue
}
