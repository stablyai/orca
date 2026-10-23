import { stopAgentSessionProviderRoot } from './structured-agent-session-provider-exit-proof'
import type { StructuredAgentSessionAcquisitionReceipt } from './structured-agent-session-startup-attempt-contract'
import type { StructuredAgentRegistration } from './structured-agent-registry'
import type {
  StructuredAgentSessionAcquireInput,
  StructuredAgentSessionAdapter
} from './structured-agent-session-adapter'

export type SessionRoute = {
  registration: StructuredAgentRegistration
  state: 'acquiring' | 'live' | 'stopped'
  acquisition?: StructuredAgentSessionAcquisitionReceipt
}

/** The route retains the actual startup identity until its exit is durably acknowledged. */
export async function acquireSessionRoute(
  input: StructuredAgentSessionAcquireInput,
  registration: StructuredAgentRegistration,
  routes: Map<string, SessionRoute>,
  isClosed: () => boolean
) {
  const route: SessionRoute = {
    registration,
    state: 'acquiring',
    ...(input.attemptId && input.launch
      ? {
          acquisition: {
            attemptId: input.attemptId,
            fence: input.fence,
            spawnToken: input.spawnToken,
            location: input.launch.location
          }
        }
      : {})
  }
  routes.set(input.identity.sessionId, route)
  try {
    const acquired = await registration.adapter.acquire({
      ...input,
      onSpawned: async (process) => {
        if (route.acquisition) {
          route.acquisition.process = process
        }
        await input.onSpawned?.(process)
      }
    })
    if (route.acquisition) {
      route.acquisition.process = acquired.process
    }
    if (isClosed()) {
      throw new Error('structured session adapter router is closed')
    }
    route.state = 'live'
    return acquired
  } catch (error) {
    if (
      routes.get(input.identity.sessionId) === route &&
      !registration.adapter.hasOwnedAcquisition?.(input.identity.sessionId)
    ) {
      routes.delete(input.identity.sessionId)
    }
    throw error
  }
}

/** Releases only the actual routed acquisition, retaining its observed exit until acknowledged. */
export async function releaseSessionRoute(
  input: { sessionId: string },
  routes: Map<string, SessionRoute>,
  adapters: () => StructuredAgentSessionAdapter[]
): Promise<boolean> {
  const route = routes.get(input.sessionId)
  if (route) {
    if (route.state === 'stopped') {
      return true
    }
    if (!route.registration.adapter.hasOwnedAcquisition?.(input.sessionId)) {
      if (routes.get(input.sessionId) === route) {
        routes.delete(input.sessionId)
      }
      return false
    }
    try {
      let exitReport: Error | undefined
      const stopped = await stopAgentSessionProviderRoot(
        () => route.registration.adapter.releaseAcquisition?.(input) ?? Promise.resolve(false),
        (error) => {
          exitReport = error
        }
      )
      if (stopped && routes.get(input.sessionId) === route) {
        route.state = 'stopped'
      }
      if (exitReport) {
        throw exitReport
      }
      return stopped
    } catch (error) {
      if (
        routes.get(input.sessionId) === route &&
        route.state !== 'stopped' &&
        !route.registration.adapter.hasOwnedAcquisition?.(input.sessionId)
      ) {
        routes.delete(input.sessionId)
      }
      throw error
    }
  }
  let released = false
  for (const candidate of adapters()) {
    released = (await candidate.releaseAcquisition?.(input)) === true || released
  }
  return released
}
