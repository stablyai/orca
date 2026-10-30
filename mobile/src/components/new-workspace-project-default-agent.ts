import { z } from 'zod'
import { PROJECT_DEFAULT_AGENT_RUNTIME_CAPABILITY } from '../../../src/shared/agent-launch-runtime-capability'
import { getRepoExecutionHostId } from '../../../src/shared/execution-host'
import type { TuiAgent } from '../../../src/shared/tui-agent'
import { isTuiAgent } from '../../../src/shared/tui-agent-config'
import type { RpcClient } from '../transport/rpc-client'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import { worktreeCreateCapabilityRead } from '../tasks/mobile-workspace-create-operations'
import type { MobileWorkspaceRepo } from './new-worktree-modal-types'

const resolvedDefaultSchema = z.object({
  agent: z.custom<TuiAgent>(isTuiAgent).nullable(),
  source: z.enum(['project', 'global', 'automatic']),
  projectId: z.string().optional(),
  projectName: z.string().optional()
})

const resolveDefaultRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'agent.resolve-project-default',
    method: 'agent.resolveDefault',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('resolved-default-agent', resolvedDefaultSchema)
  })
)

export async function resolveMobileNewWorkspaceDefaultAgent(
  client: RpcClient,
  repo: MobileWorkspaceRepo
): Promise<z.infer<typeof resolvedDefaultSchema>> {
  const status = worktreeCreateCapabilityRead.interpret(
    await worktreeCreateCapabilityRead.request(client)
  )
  if (!status.accepted) {
    throw new Error(
      `Could not verify default-agent support on ${repo.displayName}'s host. Try again.`
    )
  }
  if (!status.value.capabilities?.includes(PROJECT_DEFAULT_AGENT_RUNTIME_CAPABILITY)) {
    throw new Error(`Update the target Orca host to use the default agent for ${repo.displayName}.`)
  }
  const hostId = getRepoExecutionHostId(repo)
  const reply = await resolveDefaultRead.request(client, {
    repo: `id:${repo.id}`,
    repoHostId: hostId
  })
  return resolveDefaultRead.interpret(reply)
}
