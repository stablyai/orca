import { track } from '../../../telemetry/client'
import { getCohortAtEmit } from '../../../telemetry/cohort-classifier'
import {
  agentKindSchema,
  launchSourceSchema,
  requestKindSchema
} from '../../../../shared/telemetry-events'
import type { PtySpawnIpcArgs } from '../ipc/spawn-types'

export function recordPtySpawnTelemetry(
  telemetry: NonNullable<PtySpawnIpcArgs['telemetry']>
): void {
  const agentKind = agentKindSchema.safeParse(telemetry.agent_kind)
  const launchSource = launchSourceSchema.safeParse(telemetry.launch_source)
  const requestKind = requestKindSchema.safeParse(telemetry.request_kind)
  if (agentKind.success && launchSource.success && requestKind.success) {
    track('agent_started', {
      agent_kind: agentKind.data,
      launch_source: launchSource.data,
      request_kind: requestKind.data,
      ...getCohortAtEmit()
    })
  }
}
