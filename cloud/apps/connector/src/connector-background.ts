import type { ConnectorInbox } from './connector-inbox.js'
import type { SlackEdge } from './slack-edge.js'

// Chains each sweep after the previous one settles, so a slow database never stacks them.
export function every(label: string, intervalMs: number, run: () => Promise<unknown>): () => void {
  let timer: NodeJS.Timeout | undefined
  let stopped = false
  const schedule = (): void => {
    if (stopped) {
      return
    }
    timer = setTimeout(() => {
      void run()
        .catch((error: unknown) => {
          console.warn(
            JSON.stringify({
              event: 'orca_connector_sweep_failed',
              target: label,
              error: error instanceof Error ? error.name : 'unknown'
            })
          )
        })
        .finally(schedule)
    }, intervalMs)
    timer.unref()
  }
  schedule()
  return () => {
    stopped = true
    clearTimeout(timer)
  }
}

const EXPIRY_SWEEP_INTERVAL_MS = 15_000
const INBOX_PRUNE_INTERVAL_MS = 60_000
// Settled rows keep only ids and results; this bounds how long even those stay.
const INBOX_RETENTION_MS = 7 * 24 * 60 * 60_000

export function startConnectorBackground(runtime: {
  inbox: {
    expireDue: ConnectorInbox['expireDue']
    pruneSettled(retentionMs: number): Promise<number>
  }
  slack?: Pick<SlackEdge, 'onExpired' | 'startBackground'>
}): () => void {
  const stops = [
    every('inbox_expiry', EXPIRY_SWEEP_INTERVAL_MS, async () => {
      const threads = await runtime.inbox.expireDue(runtime.slack?.onExpired)
      if (threads.length > 0) {
        console.log(JSON.stringify({ event: 'orca_connector_deliveries_expired', threads: threads.length }))
      }
    }),
    every('inbox_retention', INBOX_PRUNE_INTERVAL_MS, () =>
      runtime.inbox.pruneSettled(INBOX_RETENTION_MS)
    ),
    runtime.slack?.startBackground() ?? (() => {})
  ]
  return () => {
    for (const stop of stops) {
      stop()
    }
  }
}
