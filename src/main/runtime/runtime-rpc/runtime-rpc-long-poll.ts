import type { RpcRequest } from '../rpc/core'
import { ORCA_SESSION_ADDRESS_PREFIX } from '../../../shared/orca-session-address'

export const KEEPALIVE_INTERVAL_MS = 10_000

// Reserve half the 32 connections for short RPCs; overflow returns runtime_busy (design §7).
export const LONG_POLL_CAP = 16

// Ask may block for minutes; reserve half the long-poll budget so waiting workers cannot starve other clients.
export const ASK_LONG_POLL_SHARE = 0.5
// Eight host slots allow two paired desktops to overlap four hosts each.
export const BROWSER_HOST_LONG_POLL_SHARE = 0.5
// Asks plus permanent hosts leave the prior quarter-budget reservation for waits.
export const SPECIALIZED_LONG_POLL_SHARE = 0.75

// Ask shares abort/keepalive wiring but has a separate admission sub-cap.
export type RuntimeLongPollClass = 'ask' | 'browser-host' | 'wait'

// One long-poll classifier owns admission, abort and keepalive (design §3.1).
export function classifyRuntimeLongPoll(request: RpcRequest): RuntimeLongPollClass | null {
  // Worker readiness plus prompt verification can take 90–110s; keep Unix and Windows pipe connections alive.
  if (request.method === 'orchestration.workerStart') {
    return 'wait'
  }
  // Prompts wait for readiness; workspace creates can also wait a minute for setup without a prompt.
  if (
    (request.method === 'agent.launch' || request.method === 'agent.launchReplay') &&
    typeof request.params === 'object' &&
    request.params !== null &&
    (('prompt' in request.params && request.params.prompt !== undefined) ||
      ('target' in request.params &&
        typeof request.params.target === 'object' &&
        request.params.target !== null &&
        'kind' in request.params.target &&
        request.params.target.kind === 'create-worktree'))
  ) {
    return 'wait'
  }
  // Chat inject may wait 60s for acceptance and needs keepalive past 30s idle; terminal inject stays a short RPC.
  if (
    request.method === 'orchestration.dispatch' &&
    typeof request.params === 'object' &&
    request.params !== null &&
    'inject' in request.params &&
    request.params.inject === true &&
    'to' in request.params &&
    typeof request.params.to === 'string' &&
    request.params.to.startsWith(ORCA_SESSION_ADDRESS_PREFIX)
  ) {
    return 'wait'
  }
  if (request.method === 'browser.clientHost.attach') {
    return 'browser-host'
  }
  if (request.method === 'terminal.wait') {
    return 'wait'
  }
  // Prompt submission waits for lifecycle verification; keep the socket alive.
  if (
    request.method === 'terminal.send' &&
    typeof request.params === 'object' &&
    request.params !== null &&
    (request.params as { agentPrompt?: unknown }).agentPrompt === true
  ) {
    return 'wait'
  }
  // Ask blocks by default up to 600s; keepalive avoids idle timeout and disconnect abort releases the waiter.
  if (request.method === 'orchestration.ask') {
    return 'ask'
  }
  if (request.method === 'orchestration.check') {
    const params = request.params as { wait?: unknown } | undefined
    return params?.wait === true ? 'wait' : null
  }
  return null
}
