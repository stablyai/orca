import { randomUUID } from 'node:crypto'
import {
  AgentSessionAcquisitionExitProvenError,
  AgentSessionAcquisitionExitUnprovenError,
  AgentSessionAcquisitionRootExitObservedError
} from '../../../native-chat/agent-session-wire/acquisition/structured-agent-session-acquisition-errors'
import {
  AgentSessionPreSpawnError,
  isAgentSessionPreSpawnError
} from '../../../native-chat/agent-session-wire/providers/structured-agent-session-adapter-errors'
import type {
  AgentSessionAcquisition,
  StructuredAgentSessionAcquireInput
} from '../../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import { withObservedProviderExit } from '../../../native-chat/agent-session-wire/startup/structured-agent-session-failure-text'
import { acpAgentName } from '../acp-structured-agent-definitions'
import { acquireAcpStructuredSession } from '../acp-structured-acquire'
import type { ProviderStartAttempt } from '../../../provider-process/provider-acquisition-starts'
import {
  waitForAcpExit,
  type AcpStructuredConnection
} from '../../process/acp-structured-connection'
import { AcpConnectionClosedError } from '../../transport/acp-errors'
import { withProviderSpawnAbsence } from '../../../provider-process/provider-executable-missing'
import { acpRefusedStart } from './acp-startup-outcome'
import type { AcpStructuredSessionAdapterDeps } from '../acp-structured-session-adapter-deps'
import type { AcpStructuredChildren } from '../children/acp-structured-child-lifecycle'

export async function startAcpStructuredSession(
  deps: AcpStructuredSessionAdapterDeps,
  children: AcpStructuredChildren,
  input: StructuredAgentSessionAcquireInput,
  attempt: ProviderStartAttempt<AcpStructuredConnection>,
  now: () => number,
  graceMs: () => number
): Promise<AgentSessionAcquisition> {
  const sessionId = input.identity.sessionId
  const generation = deps.mintGeneration?.() ?? randomUUID()
  children.endings.admit(sessionId, generation)
  try {
    const { acquisition, session } = await acquireAcpStructuredSession({
      acquire: input,
      deps: deps,
      generation,
      abandoned: () => attempt.signal.aborted,
      track: (connection) => {
        connection.onExit((_exit, requested, lost) => {
          if (!requested) {
            input.events?.observeRootExit?.()
            children.recordExit(sessionId, generation, connection, lost)
          }
        })
        children.starts.track(attempt, connection)
        deps.spec.launchGate?.retain(connection)
      },
      onExit: (session) => {
        if (session && children.sessions.get(sessionId) === session) {
          children.finish(session, now())
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
    children.endings.retire(sessionId, generation)
    const { connection } = attempt
    if (connection && error instanceof AcpConnectionClosedError) {
      // Wait briefly for process exit so startup failures include final diagnostics.
      await waitForAcpExit(connection, graceMs(), attempt.signal)
    }
    // Orca closing the connection first, such as on a sign-in line it cannot read, is the start's
    // cause; the exit its cleanup then causes is not the agent ending unanswered. Capture
    // spontaneous exit before close can classify it as requested.
    const exitedOnItsOwn =
      connection?.exited === true && !attempt.signal.aborted && !connection.lostBeforeExit
    const cleaned = connection && (await connection.close().catch(() => false))
    // Read after cleanup, which may be what observes the refusal; it outranks generic errors.
    const refused = connection?.lostBeforeExit
    const cause = refused ? acpRefusedStart(refused) : error
    if (connection && !cleaned) {
      // Retain failed cleanup for retry before another child can spawn.
      children.starts.retainFailed(sessionId, connection)
      throw new AgentSessionAcquisitionExitUnprovenError(cause)
    }
    if (connection?.lastCloseResult?.killDelivered && !connection.exited) {
      throw new AgentSessionAcquisitionRootExitObservedError(cause, 'kill-delivered')
    }
    if (attempt.signal.aborted) {
      const closed = new Error(`${acpAgentName(deps.spec.agent)} was closed while starting`, {
        cause: error
      })
      throw connection ? closed : new AgentSessionPreSpawnError(closed)
    }
    // Once the exit is proven, the start's error names a CLI or folder the spawn found missing.
    if (cause instanceof Error && connection?.exited) {
      withProviderSpawnAbsence(cause, connection.spawnAbsence)
    }
    if (connection && exitedOnItsOwn && !isAgentSessionPreSpawnError(error)) {
      throw new AgentSessionAcquisitionExitProvenError(
        withObservedProviderExit(
          new Error(connection.stderrTail() || String(error), { cause: error })
        )
      )
    }
    throw cause
  }
}
