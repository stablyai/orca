import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'

export function withPinnedReservationFields(
  existing: AgentSessionRecord,
  request: { launchArgs?: string[]; additionalDirectories?: string[]; now: number }
): AgentSessionRecord {
  const pinLaunchArgs = !existing.launchArgs && request.launchArgs
  const pinDirectories =
    !existing.additionalDirectories && request.additionalDirectories?.length
      ? request.additionalDirectories
      : undefined
  return {
    ...existing,
    ...(pinLaunchArgs ? { launchArgs: [...pinLaunchArgs] } : {}),
    ...(pinDirectories ? { additionalDirectories: [...pinDirectories] } : {}),
    ...(pinLaunchArgs || pinDirectories ? { updatedAt: request.now } : {})
  }
}
