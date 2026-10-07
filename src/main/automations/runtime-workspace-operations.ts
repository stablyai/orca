import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { Automation } from '../../shared/automations-types'
import { getAutomationWorkspaceRecoveryTarget } from '../../shared/automation-workspace-recovery-target'
import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  toSshExecutionHostId
} from '../../shared/execution-host'
import { resolveFolderWorkspaceHost } from '../../shared/folder-workspace-execution-host'
import { folderWorkspaceKey, parseWorkspaceKey } from '../../shared/workspace-scope'
import { worktreeIdsEqual } from '../../shared/worktree/id'
import {
  connectRegisteredSshTarget,
  getRegisteredSshState,
  registeredSshTargetNeedsInteractiveCredentials
} from '../ssh/ssh-target-registry'
import { buildHeadlessAutomationWorktreeCreateArgs } from './headless-workspace-create'
import type {
  AutomationWorkspaceOperations,
  AutomationWorkspaceProbe,
  RunnableAutomationTarget
} from './automation-workspace-recovery'

type WorkspaceRuntime = Pick<
  OrcaRuntimeService,
  | 'listDetectedManagedWorktrees'
  | 'invalidateWorktreeCatalog'
  | 'createManagedWorktree'
  | 'createFolderWorkspace'
>
type WorkspaceStore = Pick<Store, 'getFolderWorkspaces' | 'getProjectGroups' | 'getRepos'>

export function createRuntimeAutomationWorkspaceOperations(
  runtime: WorkspaceRuntime,
  store: WorkspaceStore
): AutomationWorkspaceOperations {
  return {
    probe: async (automation, target) => {
      const connection = await connectAutomationWorkspaceHost(target)
      if (connection) {
        return connection
      }
      const scope = parseWorkspaceKey(automation.workspaceId ?? '')
      if (scope?.type === 'folder') {
        return probeFolderWorkspace(store, automation, target)
      }
      runtime.invalidateWorktreeCatalog(target.repo.id)
      const host = parseExecutionHostId(getRepoExecutionHostId(target.repo))
      const listing = await runtime.listDetectedManagedWorktrees(
        `id:${target.repo.id}`,
        host?.kind === 'ssh' ? host.targetId : null
      )
      if (!listing.authoritative) {
        return {
          kind: 'unverifiable',
          error: 'The automation workspace could not be verified on its host.'
        }
      }
      const id = scope?.type === 'worktree' ? scope.worktreeId : automation.workspaceId
      const workspace = id
        ? listing.worktrees.find((entry) => worktreeIdsEqual(entry.id, id))
        : undefined
      if (workspace?.removing) {
        return { kind: 'unverifiable', error: 'The automation workspace is still being removed.' }
      }
      return workspace && !workspace.prunable
        ? { kind: 'available', workspace }
        : { kind: 'missing' }
    },
    create: async (automation, run, target) => {
      const recovery = getAutomationWorkspaceRecoveryTarget(automation)
      if (!recovery) {
        throw new Error('The target workspace is no longer available.')
      }
      if (recovery.kind === 'folder') {
        assertFolderRecoveryHost(recovery.connectionId, target)
        const folder = await runtime.createFolderWorkspace({
          projectGroupId: recovery.projectGroupId,
          folderPath: recovery.folderPath,
          connectionId: recovery.connectionId,
          name: automation.name
        })
        return { id: folderWorkspaceKey(folder.id), displayName: folder.name }
      }
      const created = await runtime.createManagedWorktree(
        buildHeadlessAutomationWorktreeCreateArgs({
          automation: { ...automation, baseBranch: recovery.baseBranch },
          run,
          repo: target.repo,
          startAgent: false
        })
      )
      return created.worktree
    }
  }
}

async function connectAutomationWorkspaceHost(
  target: RunnableAutomationTarget
): Promise<AutomationWorkspaceProbe | null> {
  const host = parseExecutionHostId(getRepoExecutionHostId(target.repo))
  if (host?.kind !== 'ssh' || getRegisteredSshState(host.targetId)?.status === 'connected') {
    return null
  }
  if (registeredSshTargetNeedsInteractiveCredentials(host.targetId)) {
    return {
      kind: 'unverifiable',
      status: 'skipped_needs_interactive_auth',
      error: 'SSH reconnect requires interactive credentials.'
    }
  }
  const connected = await connectRegisteredSshTarget(host.targetId)
  return connected.status === 'connected'
    ? null
    : { kind: 'unverifiable', error: 'SSH target is unavailable.' }
}

function assertFolderRecoveryHost(
  connectionId: string | null,
  target: RunnableAutomationTarget
): void {
  const hostId = connectionId ? toSshExecutionHostId(connectionId) : 'local'
  if (hostId !== getRepoExecutionHostId(target.repo)) {
    throw new Error('The target workspace is on a different host than this automation run target.')
  }
}

function probeFolderWorkspace(
  store: WorkspaceStore,
  automation: Automation,
  target: RunnableAutomationTarget
): AutomationWorkspaceProbe {
  const scope = parseWorkspaceKey(automation.workspaceId ?? '')
  if (scope?.type !== 'folder') {
    return { kind: 'missing' }
  }
  const state = {
    folderWorkspaces: store.getFolderWorkspaces(),
    projectGroups: store.getProjectGroups(),
    repos: store.getRepos()
  }
  const folder = state.folderWorkspaces.find((entry) => entry.id === scope.folderWorkspaceId)
  if (!folder) {
    const recovery = getAutomationWorkspaceRecoveryTarget(automation)
    if (recovery?.kind === 'folder') {
      assertFolderRecoveryHost(recovery.connectionId, target)
    }
    return { kind: 'missing' }
  }
  const host = resolveFolderWorkspaceHost(state, folder.id)
  if (host.kind === 'ambiguous' || host.kind === 'missing') {
    return { kind: 'unverifiable', error: 'The automation workspace has no single execution host.' }
  }
  assertFolderRecoveryHost(host.kind === 'ssh' ? host.targetId : null, target)
  return {
    kind: 'available',
    workspace: { id: folderWorkspaceKey(folder.id), displayName: folder.name }
  }
}
