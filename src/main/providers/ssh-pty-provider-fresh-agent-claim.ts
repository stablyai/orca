import {
  isAgentSessionExecutionClaim,
  type AgentSessionExecutionClaim
} from '../../shared/agent-session-host-authority'
import type { TuiAgent } from '../../shared/tui-agent'
import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import type { SshAgentSessionCapabilities } from './ssh-agent-session-capabilities'

export async function createFreshSshAgentSessionClaim(
  mux: SshChannelMultiplexer,
  capabilities: SshAgentSessionCapabilities,
  args: {
    worktreeId: string
    agent: TuiAgent
    launchIdentity: string
    signal?: AbortSignal
  }
): Promise<AgentSessionExecutionClaim | null> {
  if (!(await capabilities.supportsFreshClaims({ signal: args.signal }))) {
    return null
  }
  const result = await mux.request(
    'pty.issueAgentSessionClaim',
    {
      worktreeId: args.worktreeId,
      agent: args.agent,
      launchIdentity: args.launchIdentity
    },
    { signal: args.signal, timeoutMs: 5_000 }
  )
  return isAgentSessionExecutionClaim(result) ? result : null
}
