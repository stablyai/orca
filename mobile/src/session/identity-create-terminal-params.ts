import type { AgentLaunchSpawnRequest } from '../../../src/shared/agent-launch-spawn-request'
import type { RpcClient } from '../transport/rpc-client'
import { hostSupportsAgentLaunchIdentity } from './agent-launch-identity-capability'

export const MOBILE_AGENT_LAUNCH_IDENTITY_UNSUPPORTED_MESSAGE =
  'This Orca desktop is too old to launch agents. Update Orca on the desktop.'

// Why: mobile agent launches send identity only — the host runs its own
// newest-revision default pick (oracle-19) rather than a client-cached agent id.
// A pre-identity host STRIPS the unknown field and spawns a bare login shell it
// still reports as a created terminal, so the caller's prompt would be typed into
// a shell and executed. These surfaces keep no client-assembled command to
// degrade to, so an unsupported host must fail before anything is created.
export async function resolveIdentityCreateTerminalParams(
  client: Pick<RpcClient, 'sendRequest'>,
  worktreeId: string
): Promise<{ worktree: string; agentLaunch: AgentLaunchSpawnRequest }> {
  const status = await client.sendRequest('status.get').catch(() => null)
  if (!(status?.ok === true && hostSupportsAgentLaunchIdentity(status.result))) {
    throw new Error(MOBILE_AGENT_LAUNCH_IDENTITY_UNSUPPORTED_MESSAGE)
  }
  return {
    worktree: `id:${worktreeId}`,
    // allowEmptyPromptLaunch: these surfaces launch a bare TUI with no prompt, and
    // without it the host's plan builder returns null and fails no_agent_selected.
    agentLaunch: { selection: { kind: 'default' }, allowEmptyPromptLaunch: true }
  }
}
