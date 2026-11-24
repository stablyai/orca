import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { AgentLaunchPreferences } from '../../../../../../shared/agent-session/lifecycle/operations/agent-session-host-authority'
import type { OrchestrationWorkerLaunchReceipt } from './start/launch/worker-launch-preferences'

export type SystemWorkerCoordinator = {
  workspaceId: string
  requiredMode?: 'structured' | 'terminal'
  launchPreferences?: AgentLaunchPreferences
  launchReceipt?: OrchestrationWorkerLaunchReceipt
  taskOnly?: boolean
  decorateTask?: (task: string, cliCommand: string) => string
  prepared: (
    worker: { dispatchId: string; sessionId: string },
    authority: { paneKey: string | null }
  ) => void
}

export function applySystemWorkerLaunch(
  coordinator: SystemWorkerCoordinator | undefined,
  launch: {
    preferences: AgentLaunchPreferences | undefined
    receipt: OrchestrationWorkerLaunchReceipt
  }
): void {
  if (coordinator?.launchReceipt) {
    launch.receipt = coordinator.launchReceipt
  }
  if (coordinator?.launchPreferences) {
    launch.preferences = coordinator.launchPreferences
  }
}

export function systemWorkerStartIsReady(result: unknown): boolean {
  return Boolean(
    result && typeof result === 'object' && 'state' in result && result.state === 'ready'
  )
}

export function assertSystemWorkerMode(
  coordinator: SystemWorkerCoordinator | undefined,
  mode: 'structured' | 'terminal'
): void {
  if (coordinator?.requiredMode && mode !== coordinator.requiredMode) {
    throw new Error('pipeline_surface_unavailable')
  }
}

export function bindSystemWorkerCoordinator(
  coordinator: SystemWorkerCoordinator | undefined,
  db: OrchestrationDb,
  paneKey: string | null,
  dispatchId: string,
  sessionId: string
): void {
  if (!coordinator) {
    return
  }
  if (paneKey) {
    db.keepWorkerTerminalOpen(paneKey)
  }
  coordinator.prepared({ dispatchId, sessionId }, { paneKey })
}
