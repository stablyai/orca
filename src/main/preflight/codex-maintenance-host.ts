import type {
  CodexMaintenanceParams,
  CodexMaintenanceState
} from '../../shared/codex-cli-maintenance'
import { codexMaintenanceRunner } from './codex-maintenance-runner'
import type { CodexCommandSettings } from '../codex/configured-codex-invocation'

/** Runs on the host that owns the chat; structured chat has no SSH execution host today. */
export async function codexMaintenanceOnHost(
  params: CodexMaintenanceParams,
  settings: CodexCommandSettings = {}
): Promise<CodexMaintenanceState> {
  const context = { cwd: params.cwd, commandSettings: settings }
  return params.operation === 'start'
    ? codexMaintenanceRunner.start(context)
    : codexMaintenanceRunner.status(params.operation === 'read' ? params.jobId : undefined, context)
}
