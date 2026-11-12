import { z } from 'zod'
import { isTuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent-config'
import { formatAgentTypeLabel } from '../../../../shared/agent-status/presentation/agent-type-label'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { PluginHostCallError } from './plugin-host-call-scope'
import type { PluginHostServices } from './plugin-host-method-bindings'
import type { PluginRuntimeRpc } from './plugin-host-runtime-call'

const shownWorktree = z.object({
  worktree: z.object({
    id: z.string(),
    hostId: z.string().optional(),
    identity: z.object({ key: z.string(), executionHostId: z.string() }).optional()
  })
})
const listedFolders = z.object({
  folderWorkspaces: z.array(
    z.object({
      id: z.string(),
      executionHostId: z.string().nullable().optional()
    })
  )
})
const launchSettings = z.object({
  settings: z.object({ disabledTuiAgents: z.array(z.string()) })
})

async function detectionTarget(call: PluginRuntimeRpc, workspaceId: string) {
  const scope = parseWorkspaceKey(workspaceId)
  if (scope?.type === 'folder') {
    const listed = listedFolders.parse(await call('folderWorkspace.list', undefined))
    const matches = listed.folderWorkspaces.filter(
      (folder) => folder.id === scope.folderWorkspaceId
    )
    if (matches.length !== 1) {
      throw new PluginHostCallError('conflict', 'the workspace has no unique execution host')
    }
    const host = parseExecutionHostId(matches[0].executionHostId ?? 'local')
    if (!host) {
      throw new PluginHostCallError('conflict', 'the workspace host is unknown')
    }
    return { worktreeId: workspaceId, worktreeHostId: host.id }
  }
  const selector = workspaceId.startsWith('identity:') ? workspaceId : `id:${workspaceId}`
  const { worktree } = shownWorktree.parse(await call('worktree.show', { worktree: selector }))
  const matches = workspaceId.startsWith('identity:')
    ? worktree.identity?.key === workspaceId.slice('identity:'.length)
    : worktree.id === workspaceId
  const host = parseExecutionHostId(worktree.identity?.executionHostId ?? worktree.hostId)
  if (!matches || !host || (worktree.hostId && worktree.hostId !== host.id)) {
    throw new PluginHostCallError('conflict', 'the workspace execution host changed')
  }
  return { worktreeId: worktree.id, worktreeHostId: host.id }
}

/** Reuse the native workspace probe, including SSH/WSL ownership and configured CLI paths. */
export async function availableWorkspaceAgents(
  services: Pick<PluginHostServices, 'runtimeRpc'>,
  workspaceId: string
): Promise<{ agents: { id: string; label: string }[] }> {
  const call = services.runtimeRpc
  if (!call) {
    throw new PluginHostCallError('unavailable', 'this Orca host cannot discover agents')
  }
  const target = await detectionTarget(call, workspaceId)
  const [detected, settings] = await Promise.all([
    call('preflight.detectAgents', target).then((value) => z.array(z.string()).parse(value)),
    call('settings.getAgentLaunch', undefined).then((value) => launchSettings.parse(value).settings)
  ])
  const disabled = new Set(settings.disabledTuiAgents)
  return {
    agents: [...new Set(detected)]
      .filter(isTuiAgent)
      .filter((id) => !disabled.has(id))
      .map((id) => ({ id, label: formatAgentTypeLabel(id) }))
  }
}
