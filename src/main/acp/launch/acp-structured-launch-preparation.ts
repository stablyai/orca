// Startup never installs a managed runtime; missing installations must fail before spawn.

import '../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import {
  AgentSessionAcquisitionRefusal,
  AgentSessionPreSpawnError,
  launchPreparationFailure
} from '../../native-chat/agent-session-wire/providers/structured-agent-session-adapter-errors'
import type { StructuredAgentSessionAcquireInput } from '../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import type { AntigravityChatAuthConfig } from '../../../shared/agent-accounts/antigravity/antigravity-chat-auth-config'
import { acpPrivateTempConnect } from './acp-private-temp'
import type { AcpStructuredLaunch } from './acp-structured-launch-resolution'
import type { AcpStructuredSessionAdapterDeps } from '../session/acp-structured-session-adapter-deps'
import type { AcpLaunchSpec } from './acp-launch-contract'
import type { AcpStructuredConnection, ConnectAcpAgent } from '../process/acp-structured-connection'

export function prepareAcpStructuredLaunch(
  deps: Pick<AcpStructuredSessionAdapterDeps, 'resolveLaunch'>,
  acquire: Pick<StructuredAgentSessionAcquireInput, 'identity' | 'spawnToken' | 'permissionMode'>,
  closedBeforeSpawn: () => void
): Promise<AcpStructuredLaunch> {
  const resolveLaunch = () =>
    deps.resolveLaunch({
      identity: acquire.identity,
      spawnToken: acquire.spawnToken,
      ...(acquire.permissionMode ? { permissionMode: acquire.permissionMode } : {})
    })
  return prepareAcpLaunch(resolveLaunch, closedBeforeSpawn)
}

/** Prepares the backend the launch resolved to, which the chat's account home pins. */
export async function prepareAcpLaunch<
  Launch extends {
    command: string
    env: Record<string, string>
    spec: AcpLaunchSpec
    antigravityChatAuth?: AntigravityChatAuthConfig
    release?: () => Promise<void>
  }
>(resolve: () => Promise<Launch>, closedBeforeSpawn: () => void): Promise<Launch> {
  const preparationFailure = (error: unknown): never => {
    closedBeforeSpawn()
    // An account that can't sign in says so, as the agent itself would.
    throw error instanceof AgentSessionAcquisitionRefusal && error.reason === 'notSignedIn'
      ? error
      : launchPreparationFailure(error)
  }
  const launch = await resolve().catch(preparationFailure)
  const { spec } = launch
  // Nothing has spawned yet, so a failure from here on removes the launch's own files at once.
  const failBeforeSpawn = (error: unknown): never => {
    void launch.release?.().catch(() => undefined)
    throw error
  }
  try {
    closedBeforeSpawn()
    // Only a missed lookup returns the bare command; explicit Command settings resolve or fail.
    if (spec.managedRuntime && launch.command === spec.command) {
      throw new AgentSessionPreSpawnError(
        new Error(`${spec.managedRuntime.label} is not installed on this host`),
        { reason: 'runtimeNotInstalled' }
      )
    }
    const { prepare } = spec.account
    if (prepare) {
      await prepare(launch.env, launch.antigravityChatAuth, closedBeforeSpawn).catch(
        preparationFailure
      )
      closedBeforeSpawn()
    }
  } catch (error) {
    return failBeforeSpawn(error)
  }
  return launch
}

/** Releases the launch's files once the child exits, or at once when it never spawned. */
export function acpReleaseWithChild<
  Args extends unknown[],
  Connection extends Pick<AcpStructuredConnection, 'onExit'>
>(
  connect: (...args: Args) => Connection,
  release: (() => Promise<void>) | undefined
): (...args: Args) => Connection {
  if (!release) {
    return connect
  }
  return (...args) => {
    try {
      const connection = connect(...args)
      connection.onExit(() => void release().catch(() => undefined))
      return connection
    } catch (error) {
      void release().catch(() => undefined)
      throw error
    }
  }
}

/** The connect function a launch spawns through: private temp folder, and its files released with the child. */
export async function acpLaunchConnect<
  Connection extends Pick<AcpStructuredConnection, 'onExit'> = AcpStructuredConnection
>(
  deps: Parameters<typeof acpPrivateTempConnect<Connection>>[0],
  launch: Pick<AcpStructuredLaunch, 'release'>,
  closedBeforeSpawn: () => void
): Promise<ConnectAcpAgent<Connection>> {
  const connect = deps.spec.privateTempDirectory
    ? await acpPrivateTempConnect(deps, closedBeforeSpawn).catch((error: unknown) => {
        void launch.release?.().catch(() => undefined)
        throw error
      })
    : (...args: Parameters<ConnectAcpAgent<Connection>>) => {
        closedBeforeSpawn()
        return deps.connect(...args)
      }
  return acpReleaseWithChild(connect, launch.release)
}
