/**
 * When to open the launch record ahead of a launch: once startup has settled AND a client that can
 * call `agent.launch` is connected. A profile no launching client uses never pays the open, and it
 * never runs during startup. Admission still opens it on demand.
 */
export type AgentLaunchRecordWarmupGate = {
  startupSettled(): void
  launchClientReady(): void
}

export function createAgentLaunchRecordWarmupGate(args: {
  isOpen: () => boolean
  open: () => Promise<unknown>
}): AgentLaunchRecordWarmupGate {
  let startupSettled = false
  let launchClientReady = false
  const warmIfUseful = (): void => {
    if (!startupSettled || !launchClientReady || args.isOpen()) {
      return
    }
    args.open().catch((error: unknown) => {
      // A failed warm-up costs only the first launch, which opens it itself.
      console.warn('[agent-launch] could not open the launch record ahead of a launch', error)
    })
  }
  return {
    startupSettled: () => {
      startupSettled = true
      warmIfUseful()
    },
    launchClientReady: () => {
      launchClientReady = true
      warmIfUseful()
    }
  }
}
