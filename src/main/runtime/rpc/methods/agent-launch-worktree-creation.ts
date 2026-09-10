/**
 * Creating the worktree an `agent.launch` asks for.
 *
 * `startupAgent` is the whole fork, and it is the same one `worker-worktree-creation` makes: a
 * terminal launch creates the worktree agent-first, so the startup terminal IS the agent, while a
 * structured launch creates it with no agent at all and its session is created for the worktree
 * afterwards. Setup, default tabs, provenance and lineage are identical either way.
 *
 * The executor owns which side of that fork this call lands on; nothing here re-decides it.
 */

import { buildCliWorkspaceProvenance } from '../../../../shared/cli-workspace-provenance'
import type { TuiAgent } from '../../../../shared/tui-agent'
import {
  finishAutomationWorkspaceProvenanceRequest,
  releaseAutomationWorkspaceProvenanceRequest,
  resolveAutomationWorkspaceProvenance
} from '../../../automations/workspace-provenance'
import type { AgentLaunchWorkspaceFactory } from '../../../agent-launch/agent-launch-executor'
import type { RpcContext } from '../core'
import { resolveRpcWorkspaceCreatorProvenance } from '../workspace-creator-context'
import { buildManagedWorktreeCreateArgs } from './worktree-create-args'
import type { AgentLaunchParams } from './agent-launch-schemas'

type WorktreeCreateParams = Extract<
  AgentLaunchParams['target'],
  { kind: 'create-worktree' }
>['create']

export function agentLaunchWorkspaceFactory(
  context: RpcContext,
  agent: TuiAgent
): AgentLaunchWorkspaceFactory {
  return {
    createWorktree: async ({ create, startupAgent }) => {
      // Already validated by `AgentLaunch`; the executor only removed the reserved agent fields.
      const params = create as WorktreeCreateParams
      const { runtime } = context
      return runtime.dedupeWorktreeCreate(params.repo, params.clientMutationId, async () => {
        const repo = await runtime.showRepo(params.repo)
        const automationProvenance = resolveAutomationWorkspaceProvenance({
          authority: runtime,
          repoSelector: params.repo,
          repo,
          request: params.automationProvenanceRequest
        })
        // Reserved before creation so a retry can recover; a failed attempt has to release it.
        try {
          const result = await runtime.createManagedWorktree({
            ...buildManagedWorktreeCreateArgs(
              { ...params, ...(startupAgent ? { startupAgent } : {}) },
              {
                automationProvenance,
                cliProvenance: buildCliWorkspaceProvenance(params.cliProvenanceRequest, {
                  startupAgent: agent,
                  createdAt: Date.now()
                }),
                creatorProvenance: resolveRpcWorkspaceCreatorProvenance(context)
              },
              context.clientKind ? { clientKind: context.clientKind } : {}
            ),
            // The launch owns the agent whichever surface it settles on, so the workspace records
            // it even when no startup terminal was created for it.
            createdWithAgent: agent
          })
          finishAutomationWorkspaceProvenanceRequest(params.automationProvenanceRequest)
          return {
            worktreeId: result.worktree.id,
            startupTerminalHandle: result.startupTerminal?.handle
          }
        } catch (error) {
          releaseAutomationWorkspaceProvenanceRequest(params.automationProvenanceRequest)
          throw error
        }
      })
    }
  }
}
