import { isDeepStrictEqual } from 'node:util'
import { abortSignalReason } from '../../../shared/abort-signal-reason'
import type { AgentSessionAccountHome } from '../../../shared/agent-session-account-home'
import type {
  AgentSessionProcessIdentity,
  AgentSessionRecord
} from '../../../shared/agent-session-record'
import {
  AgentSessionPreSpawnError,
  isAgentSessionPreSpawnError
} from './structured-agent-session-adapter'
import { rethrowAfterAgentSessionAcquisitionCleanup } from './structured-agent-session-provider-exit-proof'
import { journalIdentityFor } from './structured-agent-session-attach'
import type { AttachFlowInput } from './structured-agent-session-attach-flow'
import { mintStructuredAgentSessionStartupAttempt } from './structured-agent-session-startup-attempt'

/** Runtime labels identify the holder, not process identity. */
function sameOwnerProcess(
  stored: AgentSessionProcessIdentity,
  acquired: AgentSessionProcessIdentity
): boolean {
  const { runtime: _storedRuntime, ...storedProcess } = stored
  const { runtime: _acquiredRuntime, ...acquiredProcess } = acquired
  return isDeepStrictEqual(storedProcess, acquiredProcess)
}

/** Spawn makes a reservation real; the store grants write authority afterward. */
export async function acquireOwner(
  input: AttachFlowInput,
  record: AgentSessionRecord
): Promise<{
  record: AgentSessionRecord
  acquisitionGeneration: string
  accountHome?: AgentSessionAccountHome
}> {
  const fence = record.lease.runtimeFence
  const spawnToken = record.lease.reservedSpawnToken
  if (!spawnToken) {
    throw new Error('agent_session_ownership_unknown')
  }
  try {
    try {
      await input.onAcquiring?.()
    } catch (error) {
      throw new AgentSessionPreSpawnError(error)
    }
    const permissionMode = await input.launchPermissionMode?.(record)
    const accountRecipe = await input.launchAccountRecipe?.(record)
    try {
      await input.assertNoTerminalWriter?.(record)
    } catch (error) {
      // Not a code: a code message would travel as the census's own conflict, not this reason.
      throw new AgentSessionPreSpawnError(error, {
        reason: 'conversationOpenInTerminal',
        message: 'a terminal may still be writing this conversation'
      })
    }
    // Right before the spawn: a close, Stop or quit that landed during any wait above launches nothing.
    if (input.acquireSignal?.aborted) {
      throw new AgentSessionPreSpawnError(abortSignalReason(input.acquireSignal))
    }
    const attempt = mintStructuredAgentSessionStartupAttempt({
      record,
      identity: journalIdentityFor(record, input.params),
      // Retry the existing reservation instead of spawning a second child.
      spawnToken,
      ...(permissionMode ? { permissionMode } : {}),
      ...(accountRecipe ? { accountRecipe } : {}),
      ...(input.eventSink ? { events: input.eventSink } : {}),
      ...(input.acquireSignal ? { signal: input.acquireSignal } : {}),
      ...(input.startupOptions ? { startupOptions: input.startupOptions } : {}),
      ...(input.startupAttemptId ? { attemptId: input.startupAttemptId } : {})
    })
    const progress = input.onStartupAttempt?.(attempt)
    const acquired = await input.adapter.acquire({
      ...attempt,
      ...(input.recordPhase ? { recordPhase: input.recordPhase } : {}),
      onSpawned: async (process) => {
        progress?.spawned()
        record = await input.store.commitProcessIdentity({
          sessionId: record.sessionId,
          fence,
          process,
          now: input.now()
        })
      }
    })
    if (record.lease.ownerProcess === null) {
      await input.store.commitProcessIdentity({
        sessionId: record.sessionId,
        fence,
        process: acquired.process,
        now: input.now()
      })
    } else if (!sameOwnerProcess(record.lease.ownerProcess, acquired.process)) {
      throw new Error('agent_session_ownership_unknown')
    }
    const proved = await input.store.proveOwner({
      sessionId: record.sessionId,
      fence,
      ...(acquired.link ? { link: acquired.link } : {}),
      ...(acquired.accountRecipe
        ? {
            accountAcquisition: {
              generation: acquired.acquisitionGeneration,
              recipe: acquired.accountRecipe
            }
          }
        : {}),
      now: input.now()
    })
    return {
      record: proved,
      acquisitionGeneration: acquired.acquisitionGeneration,
      ...(acquired.accountHome ? { accountHome: acquired.accountHome } : {})
    }
  } catch (error) {
    if (isAgentSessionPreSpawnError(error)) {
      throw error
    }
    return rethrowAfterAgentSessionAcquisitionCleanup(input.adapter, record.sessionId, error)
  }
}
