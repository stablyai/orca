// A launch's shared-tool-process session: its caller token is kept at rest before the agent starts
// when the agent may outlive the app, and a reattached agent goes on with the token it already holds.
import type { AcpStructuredLaunch } from '../launch/acp-structured-launch-resolution'
import { SharedToolProcessSession } from '../../runtime/agent-session/environment/shared-tool-process-callers'
import { forgetKeptSharedToolChat } from '../../runtime/agent-session/environment/shared-tool-caller-store'
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
  take: (reattached: boolean) => Promise<SharedToolProcessSession | null>
  /** `create`, for the connection that owns the taken session; a failure before it exists drops it. */
  connecting: <A extends unknown[], C>(create: (...args: A) => C) => (...args: A) => C
}> {
  // Until the process exits, only its session's tools can name the chat.
  const launched = SharedToolProcessSession.forLaunch(launch.spec, launch.env, launch.version)
  const keeps = launched !== null && launch.appBoundGrants !== true && !launch.toolFree
  const kept =
    !keeps ||
    (await launched.keepAs({ ...run, owner: callerOwner(launch.env) }, providerRelayQuitting))
  // A bot's caller carries its token: unkept, its run ends with the app. Any other chat's runs on
  // as before, its caller kept in memory only.
  const appBound = !kept && launch.env[BOT_TOOLS_TOKEN_ENV] !== undefined
  // Until a connection owns it, a failed acquisition drops the session: its run never started.
  let unowned = (): void => launched?.abandon()
  return {
    relay: (start) =>
      start(appBound ? { ...launch, appBoundGrants: true } : launch).catch((error: unknown) => {
        launched?.abandon()
        throw error
      }),
    take: async (reattached) => {
      const restored = reattached
        ? await SharedToolProcessSession.reattached(
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
        await restored.settle(run.sessionId)
        unowned = () => restored.discard()
        return restored
      }
      // A reattached agent whose kept caller the keychain won't open yet keeps that entry, carried
      // to this run, so its tools have their identity once it opens.
      await launched?.settle(run.sessionId, reattached ? run.runFence : undefined)
      if (reattached) {
        // Closed before its connection took over, the reattached agent leaves no entry behind.
        unowned = () => {
          launched?.abandon()
          forgetKeptSharedToolChat(run.sessionId)
        }
      }
      return launched
    },
    connecting:
      (create) =>
      (...args) => {
        try {
          return create(...args)
        } catch (error) {
          unowned()
          throw error
        }
      }
  }
}
