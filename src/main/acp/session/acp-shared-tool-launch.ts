// A launch's shared-tool-process session: its caller token is kept at rest before the agent starts
// when the agent may outlive the app, and a reattached agent goes on with the token it already holds.
import type { AcpStructuredLaunch } from '../launch/acp-structured-launch-resolution'
import {
  SharedToolProcessSession,
  sharedToolCallerOwner
} from '../../runtime/agent-session/environment/shared-tool-process-callers'

export async function acpSharedToolLaunch<
  L extends Pick<AcpStructuredLaunch, 'spec' | 'env' | 'version' | 'appBoundGrants' | 'toolFree'>
>(
  launch: L,
  run: { sessionId: string; runFence: number }
): Promise<{
  /** The launch to relay: app-bound when its caller couldn't be kept. */
  launch: L
  /** The launch failed before any agent took the token. */
  abandon: (error: unknown) => never
  /** This launch's session, or the kept one when its agent was reattached. */
  take: (reattached: boolean) => SharedToolProcessSession | null
}> {
  // Until the process exits, only its session's tools can name the chat.
  const launched = SharedToolProcessSession.forLaunch(launch.spec, launch.env, launch.version)
  const keeps = launched !== null && launch.appBoundGrants !== true && !launch.toolFree
  const kept =
    !keeps || (await launched.keepAs({ ...run, owner: sharedToolCallerOwner(launch.env) }))
  return {
    launch: kept ? launch : { ...launch, appBoundGrants: true },
    abandon: (error) => {
      launched?.abandon()
      throw error
    },
    take: (reattached) => {
      const restored = reattached
        ? SharedToolProcessSession.reattached(
            launch.spec,
            launch.env,
            run.sessionId,
            run.runFence,
            launch.version
          )
        : null
      if (restored) {
        launched?.discard()
      }
      const session = restored ?? launched
      session?.settle(run.sessionId)
      return session
    }
  }
}
