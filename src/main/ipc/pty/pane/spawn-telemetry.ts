import { classifyError } from '../../../telemetry/classify-error'
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

/** telemetry-plan.md§agent_error: attributed to the launch's agent_kind, else a sniffed `claude`;
 *  raw messages are dropped at the validator boundary. */
export function recordPtySpawnErrorTelemetry(
  telemetry: { agent_kind?: unknown } | undefined,
  spawnError: unknown,
  isClaudeLaunch: boolean
): void {
  const parsed =
    telemetry?.agent_kind !== undefined ? agentKindSchema.safeParse(telemetry.agent_kind) : null
  const agentKind = parsed?.success ? parsed.data : isClaudeLaunch ? ('claude-code' as const) : null
  if (agentKind) {
    track('agent_error', {
      agent_kind: agentKind,
      error_class: classifyError(spawnError).error_class,
      ...getCohortAtEmit()
    })
  }
}
