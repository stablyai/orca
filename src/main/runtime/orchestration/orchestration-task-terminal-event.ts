import type { OrchestrationDb } from './db'

export type OrchestrationTaskTerminalKind = 'completed' | 'failed' | 'cancelled'

export type OrchestrationTaskTerminalEvent = {
  taskId: string
  dispatchId: string
  kind: OrchestrationTaskTerminalKind
}

export type OrchestrationTaskTerminalListener = (event: OrchestrationTaskTerminalEvent) => void

// Reply flush first. worker_done is still running inside the PTY this teardown kills.
const TEARDOWN_DEFER_MS = 0

export function emitOrchestrationTaskTerminal(
  db: { taskTerminalTeardown?: OrchestrationTaskTerminalListener },
  event: OrchestrationTaskTerminalEvent
): void {
  const listener = db.taskTerminalTeardown
  if (!listener) {
    return
  }
  setTimeout(() => {
    try {
      listener(event)
    } catch (error) {
      console.warn(
        '[orchestration] task terminal teardown failed to start',
        event.dispatchId,
        error instanceof Error ? error.message : error
      )
    }
  }, TEARDOWN_DEFER_MS)
}

export function bindOrchestrationTaskTerminalTeardown(runtime: object, db: OrchestrationDb): void {
  db.taskTerminalTeardown = (event) => {
    void import('./orchestration-task-terminal-runtime')
      .then(({ runBoundOrchestrationTaskTerminalTeardown }) =>
        runBoundOrchestrationTaskTerminalTeardown(runtime, event)
      )
      .catch((error: unknown) => {
        console.warn(
          '[orchestration] task terminal teardown failed',
          event.dispatchId,
          error instanceof Error ? error.message : error
        )
      })
  }
}
