import type { ExecOptions } from 'ssh2'

type SshAgentForwardingState = 'off' | 'pending' | 'granted' | 'refused'

// ssh2 (lib/client.js reqAgentFwd) rejects the whole exec with exactly this message.
const AGENT_FORWARDING_REFUSED_MESSAGE = 'Unable to request agent forwarding'

export function isAgentForwardingRefusedError(error: unknown): boolean {
  return error instanceof Error && error.message === AGENT_FORWARDING_REFUSED_MESSAGE
}

// Why a local type: ssh2 honors `agentForward` on exec, but @types/ssh2 omits it.
type AgentForwardingExecOptions = ExecOptions & { agentForward?: boolean }

export const AGENT_FORWARDING_EXEC_OPTIONS: AgentForwardingExecOptions = { agentForward: true }

/**
 * Per-connection agent-forwarding request state for the ssh2 transport.
 *
 * Why per exec rather than ssh2's connection-level `agentForward`: ssh2 sends the request with
 * want-reply and closes the channel when the server refuses (AllowAgentForwarding no, or
 * `restrict` in authorized_keys), then re-requests on the next exec. With the connection-level
 * flag every exec fails; OpenSSH instead warns and carries on, which is what this reproduces.
 * A refused request never reaches the exec request, so retrying the command is safe.
 */
export class SshAgentForwardingRequest {
  private state: SshAgentForwardingState

  constructor(requested: boolean) {
    this.state = requested ? 'pending' : 'off'
  }

  shouldRequest(): boolean {
    return this.state === 'pending' || this.state === 'granted'
  }

  markGranted(): void {
    if (this.state === 'pending') {
      this.state = 'granted'
    }
  }

  /** Returns true only for the first refusal, so callers log it once per connection. */
  markRefused(): boolean {
    const first = this.state !== 'refused'
    this.state = 'refused'
    return first
  }
}
