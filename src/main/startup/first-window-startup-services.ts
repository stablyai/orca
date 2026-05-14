type FirstWindowStartupServices = {
  startDaemonPtyProvider: () => Promise<void>
  startAgentHookServer: () => Promise<void>
  onDaemonError: (error: unknown) => void
  onAgentHookServerError: (error: unknown) => void
}

/**
 * Starts the services that must be ready before restored terminal panes mount.
 */
export async function startFirstWindowStartupServices({
  startDaemonPtyProvider,
  startAgentHookServer,
  onDaemonError,
  onAgentHookServerError
}: FirstWindowStartupServices): Promise<void> {
  // Why: daemon startup and hook-server binding are independent, but both gate
  // restored terminals; run them together so cold-start latency is max(), not sum().
  await Promise.all([
    startDaemonPtyProvider().catch(onDaemonError),
    startAgentHookServer().catch(onAgentHookServerError)
  ])
}
