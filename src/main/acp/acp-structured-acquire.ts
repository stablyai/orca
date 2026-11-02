import { randomUUID } from 'node:crypto'
import { constructAcpStructuredChild } from './acp-structured-child-construction'
import {
  AgentSessionAcquisitionExitProvenError,
  AgentSessionAcquisitionExitUnprovenError,
  AgentSessionAcquisitionRootExitObservedError,
  AgentSessionPreSpawnError,
  isAgentSessionPreSpawnError,
  type AgentSessionAcquisition,
  type StructuredAgentSessionAcquireInput
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { withObservedProviderExit } from '../native-chat/agent-session-wire/structured-agent-session-failure-text'
import { acpAgentName } from './acp-structured-agent-definitions'
import type { ProviderStartAttempt } from '../provider-process/provider-acquisition-starts'
import { waitForAcpExit, type AcpStructuredConnection } from './acp-structured-connection'
import { AcpConnectionClosedError } from './acp-errors'
import { withProviderSpawnAbsence } from '../provider-process/provider-executable-missing'
import {
  ACP_STOP_GRACE_MS,
  type AcpStructuredSessionAdapterDeps
} from './acp-structured-session-adapter-deps'
import type { AcpStructuredChildren } from './acp-structured-child-lifecycle'

export async function acquireAcpStructuredSession(
  input: StructuredAgentSessionAcquireInput,
  deps: AcpStructuredSessionAdapterDeps,
  children: AcpStructuredChildren
): Promise<AgentSessionAcquisition> {
  const sessionId = input.identity.sessionId
  const gate = deps.spec.launchGate?.enter(input.signal)
  const attempt = children.starts.begin(gate?.signal ?? input.signal)
  try {
    if (!(await children.stop(sessionId))) {
      throw new AgentSessionAcquisitionExitUnprovenError(
        new Error(`the previous ${deps.spec.agent} child for ${sessionId} could not be stopped`)
      )
    }
    return await startAcpStructuredSession(
      { ...input, signal: attempt.signal },
      attempt,
      deps,
      children
    )
  } finally {
    children.starts.end(attempt)
    gate?.leave()
  }
}

async function startAcpStructuredSession(
  input: StructuredAgentSessionAcquireInput,
  attempt: ProviderStartAttempt<AcpStructuredConnection>,
  deps: AcpStructuredSessionAdapterDeps,
  children: AcpStructuredChildren
): Promise<AgentSessionAcquisition> {
  const sessionId = input.identity.sessionId
  const generation = deps.mintGeneration?.() ?? randomUUID()
  try {
    const { acquisition, session } = await constructAcpStructuredChild({
      acquire: input,
      deps: deps,
      generation,
      abandoned: () => attempt.signal.aborted,
      track: (connection) => {
        children.starts.track(attempt, connection)
        deps.spec.launchGate?.retain(connection)
      },
      onExit: (session) => {
        if (session && children.sessions.get(sessionId) === session) {
          children.finish(session, (deps.now ?? Date.now)())
        }
      },
      onConnectionLost: (session, error) => children.connectionLost(session, error),
      onSettled: (settlement) => deps.onDispatchSettledLate?.({ sessionId, ...settlement }),
      forceClose: (id) => children.stopAfterFailure(id)
    })
    if (attempt.signal.aborted) {
      session.dispose()
      throw new Error('closed while starting')
    }
    children.sessions.set(sessionId, session)
    return acquisition
  } catch (error) {
    const { connection } = attempt
    if (connection && error instanceof AcpConnectionClosedError) {
      // Wait briefly for process exit so startup failures include final diagnostics.
      await waitForAcpExit(connection, deps.stopGraceMs ?? ACP_STOP_GRACE_MS, attempt.signal)
    }
    // Capture spontaneous exit before close can classify it as requested.
    const exitedOnItsOwn = connection?.exited === true && !attempt.signal.aborted
    if (connection && !(await connection.close().catch(() => false))) {
      // Retain failed cleanup for retry before another child can spawn.
      children.starts.retainFailed(sessionId, connection)
      throw new AgentSessionAcquisitionExitUnprovenError(error)
    }
    if (connection?.lastCloseResult?.killDelivered && !connection.exited) {
      throw new AgentSessionAcquisitionRootExitObservedError(error, 'kill-delivered')
    }
    if (attempt.signal.aborted) {
      const closed = new Error(`${acpAgentName(deps.spec.agent)} was closed while starting`, {
        cause: error
      })
      throw connection ? closed : new AgentSessionPreSpawnError(closed)
    }
    // Once the exit is proven, the start's error names a CLI or folder the spawn found missing.
    if (error instanceof Error && connection?.exited) {
      withProviderSpawnAbsence(error, connection.spawnAbsence)
    }
    if (connection && exitedOnItsOwn && !isAgentSessionPreSpawnError(error)) {
      throw new AgentSessionAcquisitionExitProvenError(
        withObservedProviderExit(
          new Error(connection.stderrTail() || String(error), { cause: error })
        )
      )
    }
    throw error
  }
}
