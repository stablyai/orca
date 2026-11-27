// A launch's shared-tool-process session: its caller token is kept at rest before the agent starts
// when the agent may outlive the app, and a reattached agent goes on with the token it already holds.
import type { AcpStructuredLaunch } from '../launch/acp-structured-launch-resolution'
import { SharedToolProcessSession } from '../../runtime/agent-session/environment/shared-tool-process-callers'
import { BOT_TOOLS_TOKEN_ENV } from '../../../shared/agent-session/lifecycle/launch/agent-session-caller-env'
import { botToolRelay, MCP_HOST_LIST_RELAY_OWNER } from '../../bots/tool-relay/bot-tool-relay'
import { providerRelayQuitting } from '../../provider-relay/app-provider-relays'

/** Whose relay grant a launch's caller rides on: its bot's, or the host list's. */
function callerOwner(sealed: Readonly<Record<string, string>>): string {
  const token = sealed[BOT_TOOLS_TOKEN_ENV]
  return (token ? botToolRelay.botOf(token) : null) ?? MCP_HOST_LIST_RELAY_OWNER
}

export async function acpSharedToolLaunch<
  L extends Pick<AcpStructuredLaunch, 'spec' | 'env' | 'version' | 'appBoundGrants' | 'toolFree'>
>(
  launch: L,
  run: { sessionId: string; runFence: number }
): Promise<{
  /** Relays the launch, app-bound when its caller couldn't be kept; a failure drops the token. */
  relay: <R>(start: (launch: L) => Promise<R>) => Promise<R>
  /** This launch's session, or the kept one when its agent was reattached. */
  take: (reattached: boolean) => SharedToolProcessSession | null
}> {
  // Until the process exits, only its session's tools can name the chat.
  const launched = SharedToolProcessSession.forLaunch(launch.spec, launch.env, launch.version)
  const keeps = launched !== null && launch.appBoundGrants !== true && !launch.toolFree
  const kept =
    !keeps ||
    (await launched.keepAs({ ...run, owner: callerOwner(launch.env) }, providerRelayQuitting))
  return {
    relay: (start) =>
      start(kept ? launch : { ...launch, appBoundGrants: true }).catch((error: unknown) => {
        launched?.abandon()
        throw error
      }),
    take: (reattached) => {
      const restored = reattached
        ? SharedToolProcessSession.reattached(
            launch.spec,
            launch.env,
            run.sessionId,
            run.runFence,
            providerRelayQuitting,
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
