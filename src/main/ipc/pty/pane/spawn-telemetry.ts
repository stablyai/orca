import { track } from '../../../telemetry/client'
import { getCohortAtEmit } from '../../../telemetry/cohort-classifier'
import {
  agentKindSchema,
  launchSourceSchema,
  requestKindSchema
} from '../../../../shared/telemetry-events'
import type { PtySpawnIpcArgs } from '../ipc/spawn-types'

export function recordAgentStartTelemetry(
  telemetry: NonNullable<PtySpawnIpcArgs['telemetry']>,
  backend: 'pty' | 'structured' = 'pty'
): boolean {
  const agentKind = agentKindSchema.safeParse(telemetry.agent_kind)
  const launchSource = launchSourceSchema.safeParse(telemetry.launch_source)
  const requestKind = requestKindSchema.safeParse(telemetry.request_kind)
  if (agentKind.success && launchSource.success && requestKind.success) {
    try {
      return track('agent_started', {
        semantics_version: 2,
        backend,
        agent_kind: agentKind.data,
        launch_source: launchSource.data,
        request_kind: requestKind.data,
        ...getCohortAtEmit()
      })
    } catch {
      // Telemetry must not turn a proved process start into a launch failure.
    }
  }
  return false
}
