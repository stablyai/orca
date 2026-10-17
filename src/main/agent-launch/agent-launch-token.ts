/** An agent launch with a launch config proves itself by this token, in its env and on its PTY. */
export function agentLaunchTokenFor(
  launch: { launchConfig?: unknown; launchToken?: string },
  mint: () => string
): string | undefined {
  return launch.launchConfig ? (launch.launchToken ?? mint()) : undefined
}

export function agentLaunchEnvironment(
  launch: { launchConfig?: unknown; launchToken?: string; env?: Record<string, string> },
  mint: () => string
) {
  const launchToken = agentLaunchTokenFor(launch, mint)
  const baseEnv = {
    ...launch.env,
    ...(launchToken ? { ORCA_AGENT_LAUNCH_TOKEN: launchToken } : {})
  }
  return { launchToken, baseEnv }
}
