import { isDeepStrictEqual } from 'node:util'
import { claudeRewindAcquisitionProofs } from './structured-rewind-claude-proof'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import {
  AgentSessionPreSpawnError,
  isAgentSessionPreSpawnError,
  rethrowAfterAgentSessionAcquisitionCleanup
} from './structured-agent-session-adapter'
import { journalIdentityFor } from './structured-agent-session-attach'
import type { AttachFlowInput } from './structured-agent-session-attach-flow'
import { readNativeSessionOptionRestoration } from './structured-agent-session-option-restoration'
import { withAgentSessionCreatePhase } from '../../observability/agent-session-instrumentation'
import { journalDirectoryFor } from '../agent-session-journal/journal-paths'
import { loadJournal, type JournalLoad } from '../agent-session-journal/journal-open'
import { renderJournalState } from '../agent-session-journal/journal-reducer'

/** A reservation with no process behind it is only a promise to spawn; the
 * adapter makes it real and the store then grants the writer. */
export async function acquireOwner(
  input: AttachFlowInput,
  record: AgentSessionRecord
): Promise<{
  record: AgentSessionRecord
  acquisitionGeneration: string | null
  journalLoad?: JournalLoad | null
}> {
  const { store, rewind, now } = input
  const fence = record.lease.runtimeFence
  const spawnToken = record.lease.reservedSpawnToken
  if (!spawnToken) {
    throw new Error('agent_session_ownership_unknown')
  }
  // Pre-spawn proof is single-use: this retry may create a child after the durable clear.
  try {
    try {
      record = await input.store.setReservationProcesslessProof({
        sessionId: record.sessionId,
        fence,
        spawnToken,
        processlessAt: null,
        now: input.now()
      })
      await input.onAcquiring?.()
    } catch (error) {
      throw new AgentSessionPreSpawnError(error)
    }
    let journalLoad: JournalLoad | null | undefined
    let acquisitionOptions: Readonly<Record<string, string>> | undefined
    try {
      acquisitionOptions =
        input.optionsForAcquisition?.(record, () => {
          const identity = journalIdentityFor(record, input.params)
          if (journalLoad === undefined) {
            journalLoad = loadJournal(
              journalDirectoryFor(input.journalRoot, identity),
              record.sessionId
            )
          }
          return journalLoad && !journalLoad.readOnly && !journalLoad.corrupt
            ? renderJournalState(journalLoad.state).items
            : undefined
        }) ?? record.options
    } catch (error) {
      throw new AgentSessionPreSpawnError(error)
    }
    const acquired = await input.adapter.acquire({
      identity: journalIdentityFor(record, input.params),
      ...claudeRewindAcquisitionProofs({ store, record, rewind, now }),
      fence,
      // Retries must recover the original reservation, not mint a second child.
      spawnToken,
      ...(acquisitionOptions ? { options: acquisitionOptions } : {}),
      ...(record.permissionModeRestoreValue
        ? { permissionModeRestoreValue: record.permissionModeRestoreValue }
        : {}),
      ...(input.eventSink ? { events: input.eventSink } : {}),
      ...(input.recordPhase ? { recordPhase: input.recordPhase } : {})
    })
    const restoration = await withAgentSessionCreatePhase(
      'restore_options',
      input.recordPhase,
      () =>
        readNativeSessionOptionRestoration({
          adapter: input.adapter,
          sessionId: record.sessionId,
          fence,
          ...(acquisitionOptions ? { priorOptions: acquisitionOptions } : {})
        })
    )
    if (record.lease.ownerProcess === null) {
      await input.store.commitProcessIdentity({
        sessionId: record.sessionId,
        fence,
        process: acquired.process,
        now: input.now()
      })
    } else if (!isDeepStrictEqual(record.lease.ownerProcess, acquired.process)) {
      throw new Error('agent_session_ownership_unknown')
    }
    const proved = await input.store.proveOwner({
      sessionId: record.sessionId,
      fence,
      link: acquired.link,
      now: input.now(),
      ...(restoration
        ? {
            options: restoration.options,
            ...(restoration.permissionModeRestoreValue
              ? { permissionModeRestoreValue: restoration.permissionModeRestoreValue }
              : {})
          }
        : {})
    })
    return {
      record: proved,
      acquisitionGeneration: acquired.acquisitionGeneration ?? null,
      ...(journalLoad !== undefined ? { journalLoad } : {})
    }
  } catch (error) {
    if (isAgentSessionPreSpawnError(error)) {
      throw error
    }
    return rethrowAfterAgentSessionAcquisitionCleanup(input.adapter, record.sessionId, error)
  }
}
