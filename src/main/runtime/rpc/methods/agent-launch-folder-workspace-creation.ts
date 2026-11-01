/** Folder creation is metadata-only: no Git, setup or startup terminal; launch its agent as in an existing folder workspace. */

import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { AgentLaunchWorkspaceFactory } from '../../../agent-launch/agent-launch-surface-factories'
import type { RpcContext } from '../core'
import { resolveRpcWorkspaceCreatorProvenance } from '../workspace-creator-context'
import type { AgentLaunchParams } from '../../../../shared/rpc-contract/agent-launch-params'

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
      createdWithAgent: agent
    })
    // Use the existing-target resolver so workspace id and connection match.
    const scope = await context.runtime.showTerminalWorkspaceLaunchScope(
      `id:${folderWorkspaceKey(workspace.id)}`
    )
    return { worktreeId: scope.id, workspacePath: scope.path, connectionId: scope.connectionId }
  }
}
