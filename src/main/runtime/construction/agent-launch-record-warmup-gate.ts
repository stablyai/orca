/** Warm the launch ledger only after startup settles and a launch-capable client connects; admission still opens it on demand. */
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
      // Admission retries the open if warmup fails.
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
