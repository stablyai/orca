// Startup never installs a managed runtime; missing installations must fail before spawn.

import {
  AgentSessionPreSpawnError,
  launchPreparationFailure,
  type StructuredAgentSessionAcquireInput
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { AcpStructuredLaunch } from './acp-structured-launch-resolution'
import type { AcpStructuredSessionAdapterDeps } from './acp-structured-session-adapter-deps'

export function prepareAcpStructuredLaunch(
  deps: Pick<AcpStructuredSessionAdapterDeps, 'spec' | 'resolveLaunch'>,
  acquire: Pick<StructuredAgentSessionAcquireInput, 'identity' | 'spawnToken' | 'permissionMode'>,
  closedBeforeSpawn: () => void
): Promise<AcpStructuredLaunch> {
  const resolveLaunch = () =>
    deps.resolveLaunch({
      identity: acquire.identity,
      spawnToken: acquire.spawnToken,
      ...(acquire.permissionMode ? { permissionMode: acquire.permissionMode } : {})
    })
  return prepareAcpLaunch(deps, resolveLaunch, closedBeforeSpawn)
}

export async function prepareAcpLaunch<
  Launch extends { command: string; env: Record<string, string> }
>(
  deps: Pick<AcpStructuredSessionAdapterDeps, 'spec'>,
  resolve: () => Promise<Launch>,
  closedBeforeSpawn: () => void
): Promise<Launch> {
  const { spec } = deps
  const launch = await resolve().catch(preparationFailure)
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
    await prepare(launch.env).catch(preparationFailure)
    closedBeforeSpawn()
  }
  return launch
}

function preparationFailure(error: unknown): never {
  throw launchPreparationFailure(error)
}
