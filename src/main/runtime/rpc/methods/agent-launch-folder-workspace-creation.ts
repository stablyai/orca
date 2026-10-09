/**
 * Creating the folder workspace an `agent.launch` asks for. A folder workspace is metadata only —
 * no git, no setup, no startup terminal — so the launch then starts its agent there exactly as it
 * would in a folder workspace that already existed.
 */

import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { AgentLaunchWorkspaceFactory } from '../../../agent-launch/agent-launch-surface-factories'
import type { RpcContext } from '../core'
import { resolveRpcWorkspaceCreatorProvenance } from '../workspace-creator-context'
import type { AgentLaunchParams } from './agent-launch-schemas'

type FolderWorkspaceCreateParams = Extract<
  AgentLaunchParams['target'],
  { kind: 'create-folder-workspace' }
>['create']

export function agentLaunchFolderWorkspaceCreator(
  context: RpcContext,
  agent: TuiAgent
): AgentLaunchWorkspaceFactory['createFolderWorkspace'] {
  return async ({ create }) => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: already validated by `AgentLaunch`, and the intent copies the parsed payload unchanged.
    const params = create as FolderWorkspaceCreateParams
    const workspace = await context.runtime.createFolderWorkspace({
      ...params,
      creatorProvenance: resolveRpcWorkspaceCreatorProvenance(context),
      // The launch owns the agent, as it does for a worktree it creates.
      createdWithAgent: agent
    })
    // The same resolution an `existing` target gets, so the id and connection match it exactly.
    const scope = await context.runtime.showTerminalWorkspaceLaunchScope(
      `id:${folderWorkspaceKey(workspace.id)}`
    )
    return { worktreeId: scope.id, connectionId: scope.connectionId }
  }
}
