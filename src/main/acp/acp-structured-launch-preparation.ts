// Startup never installs a managed runtime; missing installations must fail before spawn.

import '../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import {
  AgentSessionPreSpawnError,
  launchPreparationFailure
} from '../native-chat/agent-session-wire/providers/structured-agent-session-adapter-errors'
import type { StructuredAgentSessionAcquireInput } from '../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import type { AntigravityChatAuthConfig } from '../../shared/antigravity-chat-auth-config'
import type { AcpStructuredLaunch } from './acp-structured-launch-resolution'
import type { AcpStructuredSessionAdapterDeps } from './acp-structured-session-adapter-deps'
import type { AcpLaunchSpec } from './acp-launch-specs'

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
  }
>(resolve: () => Promise<Launch>, closedBeforeSpawn: () => void): Promise<Launch> {
  const preparationFailure = (error: unknown): never => {
    closedBeforeSpawn()
    throw launchPreparationFailure(error)
  }
  const launch = await resolve().catch(preparationFailure)
  const { spec } = launch
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
  return launch
}
