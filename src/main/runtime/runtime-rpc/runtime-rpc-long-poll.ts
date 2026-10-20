import type { RpcRequest } from '../rpc/core'
import { ORCA_SESSION_ADDRESS_PREFIX } from '../../../shared/orca-session-address'

export const KEEPALIVE_INTERVAL_MS = 10_000

// Why: long-polls get keepalive and an abort signal but no admission slot; a shared slot count refused waits
// whose answer was already pending and let passive waits refuse actions. Transports bound connections.
export function isRuntimeLongPoll(request: RpcRequest): boolean {
  // Worker start waits for readiness and then verifies the submitted prompt;
  // the complete operation can run for 90–110s. Keep every local transport
  // (Unix sockets and Windows named pipes) alive for that long poll.
  if (request.method === 'orchestration.workerStart') {
    return true
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
    return true
  }
  // An injected task into a chat waits for its agent to accept the turn, up to 60 s; the reply
  // must outlive the 30 s idle timer or a delivered task reads as a dead runtime. A terminal
  // inject doesn't wait, so it stays a short call.
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
    return true
  }
  if (request.method === 'browser.clientHost.attach') {
    return true
  }
  if (request.method === 'terminal.wait') {
    return true
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
    return true
  }
  // Why: orchestration.ask blocks unconditionally (default 600 s) holding the
  // RPC open until a reply lands or the deadline passes, so it needs the same
  // keepalive as check --wait or the 30 s socket idle timer tears it down. It
  // also relies on the abort signal (only wired for long-polls) to release the
  // waiter when the asking client disconnects.
  if (request.method === 'orchestration.ask') {
    return true
  }
  if (request.method === 'orchestration.check') {
    return (
      typeof request.params === 'object' &&
      request.params !== null &&
      'wait' in request.params &&
      request.params.wait === true
    )
  }
  return false
}
