import type { RpcClient } from '../transport/rpc-client'
import type { RpcSuccess } from '../transport/types'
import type { AgentCatalogValue } from '../transport/agent-catalog-sync'
import { hostSupportsAgentLaunchIdentity } from '../session/agent-launch-identity-capability'
import { buildMobileAgentPickerRows } from '../tasks/mobile-agent-catalog-projection'
import type { NewWorktreeAgentOption } from './new-worktree-agent-selection'

export async function resolveNewWorktreeAgentIdentitySupport(args: {
  client: Pick<RpcClient, 'sendRequest'>
  selectedAgent: NewWorktreeAgentOption
  catalogSnapshot: AgentCatalogValue | null
}): Promise<boolean> {
  const status = await args.client.sendRequest('status.get').catch(() => null)
  if (status?.ok) {
    return hostSupportsAgentLaunchIdentity((status as RpcSuccess).result)
  }
  if (!args.selectedAgent.isCustom) {
    return false
  }
  return buildMobileAgentPickerRows(args.catalogSnapshot, { includeCustomAgents: true }).some(
    (row) => row.isCustom && row.id === args.selectedAgent.id
  )
}
