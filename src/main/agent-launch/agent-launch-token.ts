/** An agent launch with a launch config proves itself by this token, in its env and on its PTY. */
export function agentLaunchTokenFor(
  launch: { launchConfig?: unknown; launchToken?: string },
  mint: () => string
): string | undefined {
  return launch.launchConfig ? (launch.launchToken ?? mint()) : undefined
}
