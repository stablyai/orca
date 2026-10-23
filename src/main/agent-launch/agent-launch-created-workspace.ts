import { randomUUID } from 'node:crypto'
import type { TuiAgent } from '../../shared/tui-agent'
import type { RuntimeMobileSessionTabsResult } from '../../shared/runtime-types'
import type { AgentLaunchExecution } from './agent-launch-execution'
import type { AgentLaunchWorkspaceFactory } from './agent-launch-surface-factories'

export type InitialSurfaceLaunch = NonNullable<
  RuntimeMobileSessionTabsResult['initialSurfaceLaunch']
>

type AgentLaunchRuntimeOwner = Pick<
  AgentLaunchExecution['runtime'],
  'getStructuredAgentSessionCreateSupport'
>

const liveLaunches = new WeakMap<AgentLaunchRuntimeOwner, Map<string, InitialSurfaceLaunch>>()

export function beginCreatedWorkspaceLaunch(
  runtime: AgentLaunchRuntimeOwner,
  agent: TuiAgent
): {
  onWorkspaceCreated: (worktreeId: string) => void
  createdWorktreeId: () => string | undefined
  release: () => void
} {
  const launch: InitialSurfaceLaunch = { launchId: randomUUID(), agent }
  let worktreeId: string | undefined
  return {
    onWorkspaceCreated: (createdId) => {
      worktreeId = createdId
      let byWorktree = liveLaunches.get(runtime)
      if (!byWorktree) {
        byWorktree = new Map()
        liveLaunches.set(runtime, byWorktree)
      }
      byWorktree.set(createdId, launch)
    },
    createdWorktreeId: () => worktreeId,
    release: () => {
      if (!worktreeId) {
        return
      }
      const byWorktree = liveLaunches.get(runtime)
      if (byWorktree?.get(worktreeId) !== launch) {
        return
      }
      byWorktree.delete(worktreeId)
      if (byWorktree.size === 0) {
        liveLaunches.delete(runtime)
      }
    }
  }
}

export function readCreatedWorkspaceLaunch(
  runtime: AgentLaunchRuntimeOwner,
  worktreeId: string
): InitialSurfaceLaunch | undefined {
  return liveLaunches.get(runtime)?.get(worktreeId)
}

export async function recoverCreatedWorkspace(
  workspaces: AgentLaunchWorkspaceFactory | undefined,
  worktreeId: string
): Promise<void> {
  try {
    await workspaces?.createRecoveryShell?.(worktreeId)
  } catch (error) {
    console.warn('[agent-launch] Failed to create a recovery shell:', error)
  }
}
