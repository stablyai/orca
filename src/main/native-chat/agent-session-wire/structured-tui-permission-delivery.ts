import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { isStructuredAgentSessionPermissionModeRestoreValue } from '../../../shared/structured-agent-session-permission-mode'

export function optionsAfterStructuredTuiPermissionDelivery(
  record: Pick<AgentSessionRecord, 'options'>
): Readonly<Record<string, string>> | null {
  if (
    !record.options ||
    !isStructuredAgentSessionPermissionModeRestoreValue(record.options.permissionMode)
  ) {
    return null
  }
  const { permissionMode: _delivered, ...options } = record.options
  return options
}
