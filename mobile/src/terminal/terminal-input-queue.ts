import type { ConnectionState } from '../transport/types'

export type TerminalInputQueueOperation = {
  readonly queueId: string
  readonly sequence: number
  readonly terminal: string
  readonly text: string
}

export type TerminalInputQueueSend = (
  operation: TerminalInputQueueOperation
) => Promise<'accepted' | 'rejected'>

type TerminalInputQueueItem = TerminalInputQueueOperation & {
  sequence: number
  readonly resolve: (accepted: boolean) => void
}

type TerminalInputQueueOptions = {
  readonly queueId: string
  readonly send: TerminalInputQueueSend
  readonly getConnectionState: () => ConnectionState
  readonly onConnectionStateChange: (listener: (state: ConnectionState) => void) => () => void
  readonly scheduleRetry?: (run: () => void) => () => void
}

export type TerminalInputQueue = {
  readonly enqueue: (terminal: string, text: string) => Promise<boolean>
  readonly close: () => void
}

export function createTerminalInputQueue({
  queueId,
  send,
  getConnectionState,
  onConnectionStateChange,
  scheduleRetry = scheduleDefaultRetry
}: TerminalInputQueueOptions): TerminalInputQueue {
  let nextSequence = 1
  let inFlight = false
  let closed = false
  let cancelRetry: (() => void) | null = null
  const pending: TerminalInputQueueItem[] = []
  const unsubscribe = onConnectionStateChange((state) => {
    if (state !== 'connected') {
      return
    }
    cancelScheduledRetry()
    pump()
  })

  return {
    enqueue(terminal, text) {
      if (closed || text.length === 0) {
        return Promise.resolve(false)
      }
      return new Promise<boolean>((resolve) => {
        pending.push({
          queueId,
          sequence: 0,
          terminal,
          text,
          resolve
        })
        pump()
      })
    },
    close() {
      if (closed) {
        return
      }
      closed = true
      cancelScheduledRetry()
      unsubscribe()
      for (const item of pending.splice(0)) {
        item.resolve(false)
      }
    }
  }

  function pump(): void {
    const item = pending[0]
    if (closed || inFlight || !item || getConnectionState() !== 'connected') {
      return
    }
    inFlight = true
    if (item.sequence === 0) {
      item.sequence = nextSequence
    }
    void send({
      queueId: item.queueId,
      sequence: item.sequence,
      terminal: item.terminal,
      text: item.text
    }).then(
      (outcome) => {
        inFlight = false
        if (closed || pending[0] !== item) {
          return
        }
        pending.shift()
        nextSequence += 1
        item.resolve(outcome === 'accepted')
        if (outcome === 'rejected') {
          for (const dependent of pending.splice(0)) {
            dependent.resolve(false)
          }
        }
        pump()
      },
      () => {
        inFlight = false
        if (closed || pending[0] !== item || getConnectionState() !== 'connected') {
          return
        }
        cancelScheduledRetry()
        cancelRetry = scheduleRetry(() => {
          cancelRetry = null
          pump()
        })
      }
    )
  }

  function cancelScheduledRetry(): void {
    cancelRetry?.()
    cancelRetry = null
  }
}

function scheduleDefaultRetry(run: () => void): () => void {
  const timer = setTimeout(run, 250)
  return () => clearTimeout(timer)
}
