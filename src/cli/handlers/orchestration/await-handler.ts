import type { CommandHandler } from '../../dispatch'
import { printResult } from '../../format'
import { getOptionalStringFlag } from '../../flags'
import { startCheckKeepalive } from './check-keepalive'
import { getOptionalPositiveIntegerValueFlag } from './numeric-flags'
import { resolveOrchestrationTerminalHandle } from './terminal-identity'

type AwaitResult = {
  runId: string
  deliveryId: string | null
  messages: { id: string; type: string; subject: string; from_handle: string }[]
  count: number
  wakeEvents: { reason: string; messageId: string }[]
  pendingAck?: boolean
  sweeps: number
  livenessWakes: { dispatchId: string; reason: string; detail: string }[]
  timedOut: boolean
  cancelled: boolean
  budgetMs: number
}

/** B3 (correction 2) — the coordinator's single durable subscription.
 *
 *  The runtime holds the wait for hours and re-arms its own internal slices;
 *  this command returns only when a real wake event exists, so there is no
 *  25/30/60-second model continuation loop around it. */
export const ORCHESTRATION_AWAIT_HANDLER: Record<string, CommandHandler> = {
  'orchestration await': async ({ flags, client, cwd, json }) => {
    const timeoutMs = getOptionalPositiveIntegerValueFlag(flags, 'timeout-ms')
    const from = await resolveOrchestrationTerminalHandle(flags, cwd, client, 'from')
    // Why the keepalive: the transport must not mistake a long, healthy runtime
    // wait for a dead connection.
    const stopKeepalive = startCheckKeepalive(timeoutMs)
    let result: Awaited<ReturnType<typeof client.call<AwaitResult>>>
    try {
      result = await client.call<AwaitResult>(
        'orchestration.await',
        {
          from,
          run: getOptionalStringFlag(flags, 'run'),
          ack: getOptionalStringFlag(flags, 'ack'),
          timeoutMs,
          sweepIntervalMs: getOptionalPositiveIntegerValueFlag(flags, 'sweep-interval-ms')
        },
        // Why past the budget: the client must outlive the runtime's own wait.
        { timeoutMs: (timeoutMs ?? 6 * 60 * 60 * 1000) + 60_000 }
      )
    } finally {
      stopKeepalive()
    }
    printResult(result, json, (value) => {
      if (value.timedOut) {
        return `await budget elapsed with no wake event (run ${value.runId}, ${value.sweeps} sweeps)`
      }
      if (value.cancelled) {
        return `await cancelled (run ${value.runId})`
      }
      const header = value.pendingAck
        ? `Delivery ${value.deliveryId} needs acknowledgement before the next wait`
        : `Woke for: ${value.wakeEvents.map((event) => event.reason).join(', ')}`
      return [
        header,
        ...value.messages.map(
          (message) => `  ${message.id} [${message.type}] ${message.from_handle} ${message.subject}`
        ),
        `Acknowledge with: orchestration await --ack ${value.deliveryId}`
      ].join('\n')
    })
  }
}
