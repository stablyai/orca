import { AsyncLocalStorage } from 'node:async_hooks'
import { isRecord } from '../../../../shared/agent-status/child-work/agent-status-child-work-value-guards'

// Queued commands run under the caller ahead of them, so the queue reads this at enqueue.
const effectsOptOut = new AsyncLocalStorage<true>()

/** Lets the command below an RPC handler see that its caller passed `--no-effects`. */
export function runWithRequestedActionEffects<T>(params: unknown, run: () => T): T {
  return isRecord(params) && params.noEffects === true ? effectsOptOut.run(true, run) : run()
}

export function isActionEffectsOptOut(): boolean {
  return effectsOptOut.getStore() === true
}
