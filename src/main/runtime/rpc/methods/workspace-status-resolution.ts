import { InvalidArgumentError } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { WorkspaceStatus } from '../../../../shared/worktree/types'
import {
  normalizeWorkspaceStatuses,
  resolveWorkspaceStatusInput
} from '../../../../shared/workspace-statuses'

// Why: the board catalog lives in main-side UI state, so only the host can resolve a name.
export function resolveRpcWorkspaceStatus(
  runtime: OrcaRuntimeService,
  value: string | undefined
): WorkspaceStatus | undefined {
  if (value === undefined) {
    return undefined
  }
  const statuses = normalizeWorkspaceStatuses(runtime.getUIState().workspaceStatuses)
  const resolved = resolveWorkspaceStatusInput(value, statuses)
  if (!resolved.ok) {
    throw new InvalidArgumentError(resolved.message)
  }
  return resolved.status
}
