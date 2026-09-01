import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { LAUNCH_TOKEN_ECHO_PROTOCOL_VERSION } from '../../shared/agent-launch-token-echo-protocol'
import {
  isSshCapabilityMethodUnavailable,
  SSH_AGENT_SESSION_CAPABILITY_PROBE_TIMEOUT_MS
} from './ssh-agent-session-capability-probe'

export async function sshEchoesLaunchTokens(
  mux: SshChannelMultiplexer,
  options: { signal?: AbortSignal } = {}
): Promise<boolean> {
  try {
    const result = (await mux.request('pty.getCapabilities', undefined, {
      signal: options.signal,
      timeoutMs: SSH_AGENT_SESSION_CAPABILITY_PROBE_TIMEOUT_MS
    })) as { launchTokenEchoVersion?: unknown }
    return result.launchTokenEchoVersion === LAUNCH_TOKEN_ECHO_PROTOCOL_VERSION
  } catch (error) {
    if (isSshCapabilityMethodUnavailable(error)) {
      return false
    }
    throw error
  }
}
