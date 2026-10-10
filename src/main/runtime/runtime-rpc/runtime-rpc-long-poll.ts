import type { RpcRequest } from '../rpc/core'
import { ORCA_SESSION_ADDRESS_PREFIX } from '../../../shared/orca-session-address'

export const KEEPALIVE_INTERVAL_MS = 10_000

// Why: cap observer long-polls far below the 128-connection socket budget so they can't starve actions or short RPCs; overflow → runtime_busy.
export const LONG_POLL_CAP = 16

// Why: orchestration.ask blocks on a human/agent reply for minutes, an order of
// magnitude longer than terminal.wait or check --wait, so a fleet of asking
// workers would otherwise hold every slot and starve the mobile/web/CLI/relay
// clients sharing this runtime. Reserve half the budget for the other classes.
export const ASK_LONG_POLL_SHARE = 0.5
// Why: eight host slots preserve four-host overlap for two independently paired desktops.
export const BROWSER_HOST_LONG_POLL_SHARE = 0.5
// Why: asks and permanent hosts together retain the prior quarter-budget reservation for waits.
export const SPECIALIZED_LONG_POLL_SHARE = 0.75

// Why: mutations need keepalive and cancellation but take no slot, so passive observers never refuse a user's action.
export type RuntimeLongPollClass = 'ask' | 'browser-host' | 'wait' | 'mutation'

// Why: single classifier for long-poll requests (handlers that block on an external event), shared by counter/abort/keepalive. See §3.1.
export function classifyRuntimeLongPoll(request: RpcRequest): RuntimeLongPollClass | null {
  // Worker start waits for readiness and then verifies the submitted prompt;
  // the complete operation can run for 90–110s. Keep every local transport
  // (Unix sockets and Windows named pipes) alive for that long poll.
  if (request.method === 'orchestration.workerStart') {
    return 'mutation'
  }
  // A launch with a prompt waits for the agent's readiness before writing it, up to 60 s, and a
  // reply lost to the 30 s idle timer reads as a dead runtime instead of an undelivered prompt.
  if (
    (request.method === 'agent.launch' || request.method === 'agent.launchReplay') &&
    typeof request.params === 'object' &&
    request.params !== null &&
    'prompt' in request.params &&
    request.params.prompt !== undefined
  ) {
    return 'mutation'
  }
  // An injected task into a chat waits for its agent to accept the turn, up to 60 s; the reply
  // must outlive the 30 s idle timer or a delivered task reads as a dead runtime. A terminal
  // inject doesn't wait, so it keeps its short-RPC slot.
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
    return 'mutation'
  }
  if (request.method === 'browser.clientHost.attach') {
    return 'browser-host'
  }
  if (request.method === 'terminal.wait') {
    return 'wait'
  }
  // Agent-prompt submission waits for the PTY's lifecycle transition (up to
  // the verification budget); keep the local socket alive for that wait.
  if (
    request.method === 'terminal.send' &&
    typeof request.params === 'object' &&
    request.params !== null &&
    'agentPrompt' in request.params &&
    request.params.agentPrompt === true
  ) {
    return 'mutation'
  }
  // Why: orchestration.ask blocks unconditionally (default 600 s) holding the
  // RPC open until a reply lands or the deadline passes, so it needs the same
  // keepalive as check --wait or the 30 s socket idle timer tears it down. It
  // also relies on the abort signal (only wired for long-polls) to release the
  // waiter when the asking client disconnects.
  if (request.method === 'orchestration.ask') {
    return 'ask'
  }
  if (request.method === 'orchestration.check') {
    const params = request.params as { wait?: unknown } | undefined
    return params?.wait === true ? 'wait' : null
  }
  return null
}
