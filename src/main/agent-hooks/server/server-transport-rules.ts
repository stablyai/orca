import { track } from '../../telemetry/client'

/** Keep unattributed hook deliveries visible in telemetry without rejecting the request. */
export function trackEmptyPaneKeyHook(body: unknown): void {
  if (typeof body !== 'object' || body === null) {
    return
  }
  const paneKey = (body as Record<string, unknown>).paneKey
  if (typeof paneKey === 'string' && paneKey.trim().length > 0) {
    return
  }
  track('agent_hook_unattributed', { reason: 'empty_pane_key' })
}
