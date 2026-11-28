/** Select only new, plain interactive shell launches before any provider dispatch. */
export function preferRexFreshLaunch(args: {
  command?: string
  launchAgent?: unknown
  agentLaunch?: unknown
  agentSessionEnsure?: unknown
  agentSessionCreateOperationId?: unknown
  launchConfig?: unknown
  launchToken?: unknown
  launchRuntime?: unknown
  startupCommandDelivery?: unknown
  launcherViewAttributes?: unknown
  resumeProviderSession?: unknown
  resumeOrigin?: unknown
  spawnIntent?: unknown
  attachOnlyView?: unknown
  replacesPtyId?: unknown
  wslPassiveRestore?: unknown
}): boolean {
  return (
    args.command === undefined &&
    args.launchAgent === undefined &&
    args.agentLaunch === undefined &&
    args.agentSessionEnsure === undefined &&
    args.agentSessionCreateOperationId === undefined &&
    args.launchConfig === undefined &&
    args.launchToken === undefined &&
    args.launchRuntime === undefined &&
    args.startupCommandDelivery === undefined &&
    args.launcherViewAttributes === undefined &&
    args.resumeProviderSession === undefined &&
    args.resumeOrigin === undefined &&
    (args.spawnIntent === undefined || args.spawnIntent === 'interactive') &&
    args.attachOnlyView !== true &&
    args.replacesPtyId === undefined &&
    args.wslPassiveRestore !== true
  )
}
