// What a start checks on this host before it spawns the agent. A runtime Orca manages is installed
// only when the person asks, so a start that finds no copy refuses rather than downloading one.

import {
  AgentSessionPreSpawnError,
  type StructuredAgentSessionAcquireInput
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { AcpStructuredLaunch } from './acp-structured-launch-resolution'
import type { AcpStructuredSessionAdapterDeps } from './acp-structured-session-adapter-deps'

/** The launch a start spawns; `closedBeforeSpawn` throws once the start was abandoned. */
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

/** Any spawn of the agent on this host, a chat's or not: its binary installed, its account ready. */
export async function prepareAcpLaunch<
  Launch extends { command: string; env: Record<string, string> }
>(
  deps: Pick<AcpStructuredSessionAdapterDeps, 'spec'>,
  resolve: () => Promise<Launch>,
  closedBeforeSpawn: () => void
): Promise<Launch> {
  const { spec } = deps
  const launch = await resolve().catch(preSpawnFailure)
  closedBeforeSpawn()
  // A missed lookup returns the bare name; a selected Command setting resolves or refuses.
  if (spec.managedRuntime && launch.command === spec.command) {
    throw new AgentSessionPreSpawnError(
      new Error(`${spec.managedRuntime.label} is not installed on this host`),
      { reason: 'runtimeNotInstalled' }
    )
  }
  const { prepare } = spec.account
  if (prepare) {
    await prepare(launch.env).catch(preSpawnFailure)
    closedBeforeSpawn()
  }
  return launch
}

function preSpawnFailure(error: unknown): never {
  throw new AgentSessionPreSpawnError(error)
}
