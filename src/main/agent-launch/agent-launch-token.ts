/** An agent launch with a launch config proves itself by this token, in its env and on its PTY. */
export function agentLaunchTokenFor(
  launch: { launchConfig?: unknown; launchToken?: string },
  mint: () => string
): string | undefined {
  return launch.launchConfig ? (launch.launchToken ?? mint()) : undefined
}

/** The launch token travels with the same environment the provider will execute. */
export function withAgentLaunchToken(
  env: Record<string, string> | undefined,
  launchToken: string | undefined
): Record<string, string> {
  return { ...env, ...(launchToken ? { ORCA_AGENT_LAUNCH_TOKEN: launchToken } : {}) }
}
