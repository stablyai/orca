// A launch's shared-tool-process session: when the agent may outlive the app, its caller token goes
// with the agent's spawn to the daemon start that keeps it, and a reattached agent goes on with the
// token it already holds.
import type { AcpStructuredLaunch } from '../launch/acp-structured-launch-resolution'
import { SharedToolProcessSession } from '../../runtime/agent-session/environment/shared-tool-process-callers'
import { BOT_TOOLS_TOKEN_ENV } from '../../../shared/agent-session/lifecycle/launch/agent-session-caller-env'
import { botToolRelay, MCP_HOST_LIST_RELAY_OWNER } from '../../bots/tool-relay/bot-tool-relay'

/** Whose relay grant a launch's caller rides on: its bot's, or the host list's. */
function callerOwner(env: Readonly<Record<string, string>>): string {
  const token = env[BOT_TOOLS_TOKEN_ENV]
  return (token ? botToolRelay.botOf(token) : null) ?? MCP_HOST_LIST_RELAY_OWNER
}

export function acpSharedToolLaunch<
  L extends Pick<AcpStructuredLaunch, 'spec' | 'env' | 'version' | 'appBoundGrants' | 'toolFree'>
>(
  launch: L,
  run: { sessionId: string }
): {
  /** Relays the launch, app-bound when its caller couldn't be kept; a failure drops the token. */
  relay: <R>(start: (launch: L) => Promise<R>) => Promise<R>
  /** This launch's session, or the kept one when its agent was reattached. */
  take: (reattached: boolean) => SharedToolProcessSession | null
  /** `create`, for the connection that owns the taken session; a failure before it exists drops it. */
  connecting: <A extends unknown[], C>(create: (...args: A) => C) => (...args: A) => C
  /** A last wait before the spawn; its failure drops the taken session, as `connecting`'s does. */
  beforeSpawn: <T>(wait: Promise<T>) => Promise<T>
} {
  // Until the process exits, only its session's tools can name the chat.
  const launched = SharedToolProcessSession.forLaunch(launch.spec, launch.env, launch.version)
  const keeps = launched !== null && launch.appBoundGrants !== true && !launch.toolFree
  const kept = !keeps || launched.keepWith(run.sessionId, callerOwner(launch.env))
  // A bot's caller carries its token: unkept, its run ends with the app. Any other chat's runs on
  // as before, its caller in this run's memory only.
  const appBound = !kept && launch.env[BOT_TOOLS_TOKEN_ENV] !== undefined
  // Until a connection owns it, a failed acquisition drops the session: its run never started.
  let unowned = (): void => launched?.discard()
  return {
    relay: (start) =>
      start(appBound ? { ...launch, appBoundGrants: true } : launch).catch((error: unknown) => {
        launched?.discard()
        throw error
      }),
    take: (reattached) => {
      const restored = reattached
        ? SharedToolProcessSession.reattached(
            launch.spec,
            launch.env,
            run.sessionId,
            launch.version
          )
        : null
      if (!restored) {
        // Only an agent this launch spawned holds this launch's token.
        if (!reattached) {
          launched?.started()
        }
        return launched
      }
      launched?.discard()
      unowned = () => restored.discard()
      return restored
    },
    beforeSpawn: (wait) =>
      wait.catch((error: unknown) => {
        unowned()
        throw error
      }),
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
