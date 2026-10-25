import { randomUUID } from 'node:crypto'
import type { TuiAgent } from '../../shared/tui-agent'
import type { RuntimeMobileSessionTabsResult } from '../../shared/runtime-types'
import type { AgentLaunchWorkspaceFactory } from './agent-launch-surface-factories'
import type { readAgentLaunchModeSettings } from './agent-launch-mode'

export type InitialSurfaceLaunch = NonNullable<
  RuntimeMobileSessionTabsResult['initialSurfaceLaunch']
>

type CreatedWorkspaceLaunchOwner = Parameters<typeof readAgentLaunchModeSettings>[0]

const liveLaunches = new WeakMap<CreatedWorkspaceLaunchOwner, Map<string, InitialSurfaceLaunch>>()

export function beginCreatedWorkspaceLaunch(
  runtime: CreatedWorkspaceLaunchOwner,
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
  runtime: CreatedWorkspaceLaunchOwner,
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

export function initialChatSelection<T extends { workspaceId: string; activate: boolean }>(
  runtime: CreatedWorkspaceLaunchOwner,
  input: T,
  snapshots: ReadonlyMap<string, { tabs: readonly { id: string }[]; activeTabId: string | null }>
): T {
  const snapshot = snapshots.get(input.workspaceId)
  return readCreatedWorkspaceLaunch(runtime, input.workspaceId)
    ? { ...input, activate: !snapshot?.tabs.some((tab) => tab.id === snapshot.activeTabId) }
    : input
}
