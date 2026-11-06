import { waitForPromiseWithSignal } from '../../../shared/abort-signal-reason'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-mutation-context'
import type { AgentSessionTurnContext } from './structured-agent-session-turns'
import { contextStructuredAgentSessionCurrentWork } from './structured-agent-session-current-work'
import { structuredAgentSessionSendBlock } from './structured-agent-session-send-preparation'

/** Reserve under admission; provider work and its readback never hold that lane. */
export function confirmIdleStructuredAgentSessionOption(
  context: StructuredAgentSessionMutationContext,
  ctx: AgentSessionTurnContext,
  input: { key: string; value: string }
): void {
  const { sessionId, fence } = ctx
  const { adapter, store } = context.deps
  const child = context.sessions.get(sessionId)?.child
  const eligible = (value: string): boolean => {
    const record = store.getRecord(sessionId)
    const work = contextStructuredAgentSessionCurrentWork(ctx)
    return !!(
      child &&
      context.sessions.get(sessionId)?.child === child &&
      child.phase === 'ready' &&
      !child.close &&
      child.fence === fence &&
      record?.lease.claimStatus === 'live' &&
      record.lease.runtimeFence === fence &&
      record.options?.[input.key] === value &&
      !structuredAgentSessionSendBlock(record) &&
      adapter.canSetOptionWhileIdle?.({ sessionId, fence, key: input.key, value }) === true &&
      !work.working() &&
      !work.hasActionablePrompt() &&
      !context.childWorkOpen(sessionId) &&
      !ctx.journal.queuedMessages.awaitReopenMark()
    )
  }
  if (!eligible(input.value) || !child || context.deliveryOrder.joinOptions(sessionId, child)) {
    return
  }
  const operation = context.acquireAborts.begin(
    sessionId,
    false,
    false,
    () => context.sessions.get(sessionId)?.child === child
  )
  const cycle = context.deliveryOrder.reserveOptions(sessionId, child, operation.signal)
  let finished = false
  const finish = (): void => {
    if (!finished) {
      finished = true
      operation.end()
      cycle.release()
      context.wakeDelivery(sessionId)
    }
  }
  const run = async (): Promise<void> => {
    try {
      await waitForPromiseWithSignal(cycle.before, operation.signal)
      let confirmed: string | undefined
      for (;;) {
        const pending = await context.serialize(sessionId, async () => {
          if (
            !operation.signal.aborted &&
            confirmed !== undefined &&
            eligible(confirmed) &&
            cycle.demand !== 'refresh'
          ) {
            ctx.publish()
          }
          const value = store.getRecord(sessionId)?.options?.[input.key]
          if (
            operation.signal.aborted ||
            cycle.demand !== 'refresh' ||
            value === undefined ||
            !eligible(value)
          ) {
            // Completion and the last claim are atomic with subsequent picks.
            finish()
            return null
          }
          cycle.demand = 'idle'
          return {
            value,
            written: adapter.setOption({
              sessionId,
              fence,
              key: input.key,
              value,
              signal: operation.signal
            })
          }
        })
        if (!pending) {
          return
        }
        confirmed = undefined
        try {
          await pending.written
          confirmed = pending.value
        } catch (error) {
          if (!operation.signal.aborted) {
            ctx.logger.warn('confirming idle session metadata failed', {
              scope: 'idle-option',
              sessionId,
              error
            })
          }
        }
      }
    } catch (error) {
      if (!operation.signal.aborted) {
        ctx.logger.warn('confirming idle session metadata failed', {
          scope: 'idle-option',
          sessionId,
          error
        })
      }
    } finally {
      if (!finished) {
        await context.serialize(sessionId, async () => finish())
      }
    }
  }
  const pending = run()
  context.trackProviderOperation?.(pending)
}
