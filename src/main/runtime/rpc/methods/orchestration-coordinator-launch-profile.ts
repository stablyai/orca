import type { MaestroTerminalLaunchProfile } from '../../../../shared/maestro-terminal-lease'
import { matchesMaestroTerminalLaunchProfile } from '../../../../shared/maestro-terminal-lease-transfer'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { resolveWorkerLaunchPreferences } from './orchestration/worker/worker-launch-preferences'

export function resolveCoordinatorLaunchProfile(args: {
  agent: TuiAgent
  model?: string
  effort?: string
  settings: Parameters<typeof resolveWorkerLaunchPreferences>[0]['settings']
  predecessorProfile?: MaestroTerminalLaunchProfile
}): {
  launch: ReturnType<typeof resolveWorkerLaunchPreferences>
  effectiveProfile: MaestroTerminalLaunchProfile
  drifted: boolean
} {
  const canInherit = Boolean(
    args.predecessorProfile?.serviceTier !== undefined &&
    args.predecessorProfile.environmentPolicy !== undefined
  )
  const launch = resolveWorkerLaunchPreferences({
    agent: args.agent,
    model: args.model ?? (canInherit ? (args.predecessorProfile?.model ?? undefined) : undefined),
    effort:
      args.effort ??
      (canInherit && args.model === undefined
        ? (args.predecessorProfile?.effort ?? undefined)
        : undefined),
    settings: args.settings
  })
  const effectiveProfile: MaestroTerminalLaunchProfile = {
    agent: args.agent,
    model: launch.receipt.effective?.model ?? null,
    effort: launch.receipt.effective?.effort ?? null,
    permissionMode: launch.receipt.effective?.permissionMode ?? 'default',
    routeRef: null,
    serviceTier: launch.receipt.effective?.serviceTier ?? null,
    environmentPolicy: launch.receipt.effective?.environmentPolicy ?? null
  }
  const requestedPreferenceDrift =
    (args.model !== undefined && launch.receipt.effective?.model !== args.model) ||
    (args.effort !== undefined && launch.receipt.effective?.effort !== args.effort)
  const inheritedProfileDrift =
    canInherit &&
    args.predecessorProfile !== undefined &&
    !matchesMaestroTerminalLaunchProfile(
      {
        ...effectiveProfile,
        agent: args.predecessorProfile.agent,
        model: args.model === undefined ? effectiveProfile.model : args.predecessorProfile.model,
        effort:
          args.model === undefined && args.effort === undefined
            ? effectiveProfile.effort
            : args.predecessorProfile.effort,
        routeRef: args.predecessorProfile.routeRef
      },
      args.predecessorProfile
    )
  return { launch, effectiveProfile, drifted: requestedPreferenceDrift || inheritedProfileDrift }
}
