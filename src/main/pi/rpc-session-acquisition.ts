import { randomUUID } from 'node:crypto'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import {
  AgentSessionPreSpawnError,
  AgentSessionAcquisitionExitUnprovenError,
  launchPreparationFailure,
  type AgentSessionAcquisition,
  type StructuredAgentSessionAcquireInput
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { providerSpawnedProcessIdentity } from '../provider-process/provider-spawned-process-identity'
import type { ProviderAcquisitionStarts } from '../provider-process/provider-acquisition-starts'
import { piStartExitError } from './rpc-exit-classification'
import { buildPiRpcLaunch } from './rpc-launch'
import type { PiRpcResolvedLaunch } from './rpc-launch-resolution'
import { PiRpcSession, type PiRpcConnection } from './rpc-session'
import type { PiRpcSessionAdapterDeps } from './rpc-session-adapter'

export async function acquirePiRpcSession(
  input: StructuredAgentSessionAcquireInput,
  {
    deps,
    sessions,
    starts,
    acquiring,
    acknowledgeSessionRelease
  }: {
    deps: PiRpcSessionAdapterDeps
    sessions: Map<string, PiRpcSession>
    starts: ProviderAcquisitionStarts<PiRpcConnection>
    acquiring: Set<string>
    acknowledgeSessionRelease: (id: string) => void
  }
): Promise<AgentSessionAcquisition> {
  const id = input.identity.sessionId
  if (acquiring.has(id)) {
    throw new AgentSessionPreSpawnError(new Error('Pi session already owns a child'))
  }
  acquiring.add(id)
  const attempt = starts.begin(input.signal)
  let session: PiRpcSession | undefined
  try {
    if (attempt.signal.aborted) {
      throw new AgentSessionPreSpawnError(new Error('Pi closed while starting'))
    }
    if (!(await starts.stopFailed(id))) {
      throw new AgentSessionAcquisitionExitUnprovenError(
        new Error('Previous Pi start has not exited')
      )
    }
    acknowledgeSessionRelease(id)
    if (sessions.has(id)) {
      throw new AgentSessionPreSpawnError(new Error('Pi session already owns a child'))
    }
    let launch: PiRpcResolvedLaunch
    try {
      launch = await waitForPromiseWithSignal(
        deps.resolveLaunch({ identity: input.identity, spawnToken: input.spawnToken }),
        attempt.signal
      )
    } catch (error) {
      // A start withdrawn while resolving is a close, not a failed preparation.
      throw attempt.signal.aborted
        ? new AgentSessionPreSpawnError(error)
        : launchPreparationFailure(error)
    }
    if (attempt.signal.aborted) {
      throw new AgentSessionPreSpawnError(new Error('Pi closed while starting'))
    }
    const spec = buildPiRpcLaunch(launch)
    const fresh = !launch.sessionFile && !launch.forkFile
    session = new PiRpcSession(input, randomUUID(), spec, deps, launch, fresh)
    sessions.set(id, session)
    starts.track(attempt, session.connection)
    const spawned = providerSpawnedProcessIdentity(input, 'Pi RPC', deps.readProcessStartTime)
    if (session.connection.pid !== undefined) {
      await spawned.onSpawned(session.connection.pid)
    }
    const process = await spawned.read(session.connection.pid)
    if (session.connection.closed || attempt.signal.aborted) {
      throw new Error('Pi exited while starting')
    }
    return {
      process,
      acquisitionGeneration: session.generation
    }
  } catch (error) {
    if (!session) {
      throw error instanceof AgentSessionPreSpawnError ||
        error instanceof AgentSessionAcquisitionExitUnprovenError
        ? error
        : new AgentSessionPreSpawnError(error)
    }
    const result = await session.close(false).catch(() => null)
    const exited = piStartExitError(error, session.connection, result)
    if (exited) {
      throw exited
    }
    starts.retainFailed(id, session.connection)
    throw new AgentSessionAcquisitionExitUnprovenError(error)
  } finally {
    starts.end(attempt)
    acquiring.delete(id)
  }
}
