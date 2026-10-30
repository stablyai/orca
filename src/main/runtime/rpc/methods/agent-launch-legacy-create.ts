import type { AgentLaunchResult } from '../../../../shared/agent-launch-intent'
import type { AgentLaunchParams } from '../../../../shared/rpc-contract/agent-launch-params'
import { AgentLaunchSetupError } from '../../../agent-launch/agent-launch-setup-error'
import type { OrcaRuntimeService } from '../../orca-runtime'

export function dedupeLegacyAgentLaunch(args: {
  target: AgentLaunchParams['target']
  runtime: Pick<OrcaRuntimeService, 'dedupeWorktreeCreate'>
  execute: () => Promise<AgentLaunchResult>
}): Promise<AgentLaunchResult> {
  if (args.target.kind !== 'create-worktree' || !args.target.create.clientMutationId) {
    return args.execute()
  }
  const { repo, repoHostId, clientMutationId } = args.target.create
  return args.runtime
    .dedupeWorktreeCreate(
      repoHostId ? { repo, repoHostId } : repo,
      `agent.launch:${clientMutationId}`,
      async () => {
        try {
          return await args.execute()
        } catch (error) {
          // A setup refusal already created its workspace; retain it like a completed create.
          if (error instanceof AgentLaunchSetupError) {
            return error
          }
          throw error
        }
      }
    )
    .then((result) => {
      if (result instanceof AgentLaunchSetupError) {
        throw result
      }
      return result
    })
}
