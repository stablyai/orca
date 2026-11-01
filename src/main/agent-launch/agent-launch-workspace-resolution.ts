import type { AgentLaunchExecution } from './agent-launch-execution'
import type { AgentLaunchModeReceipt } from './agent-launch-mode'
import { withoutReservedAgentCreateFields } from '../../shared/agent-launch-intent'
import { createLaunchPromptInputs } from './agent-launch-legacy-host'
import {
  terminalLaunchInputs,
  type AgentLaunchInitialSurfaceStage,
  type AgentLaunchWorkspaceFactory
} from './agent-launch-surface-factories'

export async function resolveWorkspace(
  execution: AgentLaunchExecution,
  preflight: AgentLaunchModeReceipt,
  onWorkspaceCreated?: (worktreeId: string) => void,
  initializeSurface?: AgentLaunchInitialSurfaceStage
): Promise<Awaited<ReturnType<AgentLaunchWorkspaceFactory['createWorktree']>>> {
  const { intent } = execution
  if (intent.target.kind === 'existing') {
    // Nothing was created, so there is no create warning to carry.
    const { worktree: worktreeId, connectionId, workspacePath } = intent.target
    return { worktreeId, connectionId, workspacePath, startupTerminalHandle: undefined }
  }
  const workspaces = execution.workspaces
  if (!workspaces) {
    throw new Error('agent_launch_workspace_factory_required')
  }
  execution.onStage?.('worktree_create')
  if (intent.target.kind === 'create-folder-workspace') {
    if (!workspaces.createFolderWorkspace) {
      throw new Error('agent_launch_workspace_factory_required')
    }
    const created = await workspaces.createFolderWorkspace({ create: intent.target.create })
    return { ...created, startupTerminalHandle: undefined }
  }
  const created = await workspaces.createWorktree({
    // A caller migrating from `worktree.create` passes its existing params; a stale `startupAgent`
    // in there would re-create the agent-first path this executor exists to replace. The launch
    // owns the prompt for the same reason, so it re-supplies its own rather than honouring theirs.
    create: withoutReservedAgentCreateFields(intent.target.create),
    ...(onWorkspaceCreated ? { onWorkspaceCreated } : {}),
    ...(initializeSurface ? { initializeSurface } : {}),
    ...(preflight.mode === 'structured' ? { promisedAgentChat: true } : {}),
    startupAgent: preflight.mode === 'structured' ? undefined : intent.agent,
    ...createLaunchPromptInputs(execution, preflight.mode),
    ...(preflight.mode === 'structured' ? {} : terminalLaunchInputs(intent))
  })
  // Only when a startup terminal actually came back: a create that produced none ran no command,
  // so nothing carried the prompt and the launch still owes it to whatever surface it builds next.
  const { promptRodeLaunchCommand, ...rest } = created
  return rest.startupTerminalHandle && promptRodeLaunchCommand
    ? { ...rest, promptRodeLaunchCommand: true }
    : rest
}
