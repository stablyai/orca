import type { AgentSessionOwnerProbe } from '../../shared/agent-session/lifecycle/agent-session-lease-adjudication'
import type { HostedProviderState } from '../daemon/protocol/daemon-provider-process-protocol'
import { withTimeout } from '../../shared/promise-timeout-fallback'

type ExitObservation = HostedProviderState | { state: 'absent' | 'unproven' }

/** Reconnect can restore real child authority; process-table identity is non-destructive evidence only. */
export async function observeHostedProviderExit(options: {
  query: () => Promise<HostedProviderState>
  probe: () => Promise<AgentSessionOwnerProbe>
  isSettled: () => boolean
  timeoutMs: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}): Promise<ExitObservation> {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const deadline = now() + options.timeoutMs
  let delayMs = 50
  while (!options.isSettled() && now() < deadline) {
    const state = await withTimeout<HostedProviderState>(
      options.query(),
      Math.max(1, deadline - now()),
      { state: 'unknown' }
    )
    if (state.state !== 'unknown') {
      return state
    }
    const proof = await withTimeout<AgentSessionOwnerProbe>(
      options.probe(),
      Math.max(1, deadline - now()),
      {
        outcome: 'indeterminate',
        reason: 'Exit observation timed out'
      }
    )
    if (proof.outcome === 'pid-absent') {
      return { state: 'absent' }
    }
    // A reused or ambiguous start cannot prove absence, and never grants root-signal authority.
    const remaining = deadline - now()
    if (remaining <= 0) {
      break
    }
    await sleep(Math.min(delayMs, remaining))
    delayMs = Math.min(delayMs * 2, 1_000)
  }
  return { state: 'unproven' }
}
