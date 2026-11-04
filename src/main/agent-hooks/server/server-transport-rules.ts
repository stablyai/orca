import { track } from '../../telemetry/client'
import type { AgentHookAttributionDiagnostics } from '../../../shared/agent-hook-listener/state/agent-hook-attribution-diagnostics'

/** Keep unattributed hook deliveries visible in telemetry without rejecting the request. */
export function trackEmptyPaneKeyHook(
  body: unknown,
  diagnostics: AgentHookAttributionDiagnostics
): void {
  if (typeof body !== 'object' || body === null) {
    return
  }
  const paneKey = (body as Record<string, unknown>).paneKey
  if (typeof paneKey === 'string' && paneKey.trim().length > 0) {
    return
  }
  if (diagnostics.shouldReport('empty_pane_key')) {
    track('agent_hook_unattributed', { reason: 'empty_pane_key' })
  }
}
