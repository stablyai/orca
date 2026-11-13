import type { RuntimeTerminalCreate } from '../../../../../shared/runtime-terminal-create-contract'
import { folderWorkspaceKey } from '../../../../../shared/workspace-scope'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import type { AgentLaunchWorkspaceFactory } from '../../../../agent-launch/agent-launch-surface-factories'
import type { RpcContext } from '../../core'
import { resolveRpcWorkspaceCreatorProvenance } from '../../callers/workspace-creator-context'
import type { AgentLaunchParams } from '../../../../../shared/rpc-contract/agent-launch-params'
import { toAgentLaunchPreferences } from '../../../../../shared/agent-launch/choices/agent-launch-preferences'

type FolderWorkspaceCreateParams = Extract<
  AgentLaunchParams['target'],
  { kind: 'create-folder-workspace' }
>['create']

export function agentLaunchFolderWorkspaceCreator(
  context: RpcContext,
  agent: TuiAgent
): AgentLaunchWorkspaceFactory['createFolderWorkspace'] {
  return async ({
    create,
    startupAgent,
    promisedAgentChat,
    onWorkspaceCreated,
    startupPrompt,
    agentArgs,
    cwd,
    launchSource,
    paneKey,
    options,
    accountEnv
  }) => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: AgentLaunch validated this payload before selecting its create factory.
    const params = create as FolderWorkspaceCreateParams
    let startupTerminalCreation: RuntimeTerminalCreate | undefined
    let promptRodeLaunchCommand = false
    const result = await context.runtime.createFolderWorkspace({
      ...params,
      signal: context.signal,
      creatorProvenance: resolveRpcWorkspaceCreatorProvenance(context),
      createdWithAgent: agent,
      startupAgent,
      ...(promisedAgentChat ? { agentLaunchMode: 'structured' as const } : {}),
      startupPrompt,
      startupAgentArgs: agentArgs,
      startupCwd: cwd,
      launchSource,
      startupPaneKey: paneKey,
      startupLaunchPreferences: startupAgent
        ? toAgentLaunchPreferences(options, startupAgent)
        : undefined,
      startupAccountEnv: accountEnv ? { ...accountEnv } : undefined,
      onWorkspaceCreated,
      onStartupTerminalCreated: (terminal) => {
        startupTerminalCreation = terminal
      },
      onStartupPromptCarry: (carried) => {
        promptRodeLaunchCommand = carried
      }
    })
    if (
      result.agentLaunchOutcome?.status === 'failed' ||
      (startupAgent && !result.startupTerminal?.spawned)
    ) {
      throw new Error(
        `Could not start ${agent}. Setup or agent startup did not complete. Open the workspace, check Setup and try again.`
      )
    }
    const workspace = result.folderWorkspace
    const scope = await context.runtime.showTerminalWorkspaceLaunchScope(
      `id:${folderWorkspaceKey(workspace.id)}`
    )
    return {
      worktreeId: scope.id,
      workspacePath: scope.path,
      connectionId: scope.connectionId,
      startupTerminalHandle: result.startupTerminal?.handle,
      startupTerminalCreation,
      startupTerminalPaneKey: result.startupTerminal?.paneKey ?? undefined,
      promptRodeLaunchCommand,
      warning: result.warning
    }
  }
}
