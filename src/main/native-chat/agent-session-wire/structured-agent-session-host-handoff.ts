import { join } from 'node:path'
import type { AgentSessionOwnerProbe } from '../../../shared/agent-session-lease-adjudication'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { LegacyImportOptions } from '../agent-session-journal/journal-legacy-import'
import { importLegacyTranscriptIntoJournal } from '../agent-session-journal/journal-legacy-import'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { canRestoreLiveTuiOwner } from './structured-agent-session-handoff-restart'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host'
import type { StructuredAgentSessionHostRuntimeState } from './structured-agent-session-host-runtime-state'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import { StructuredAgentSessionHandoffCoordinator } from './structured-agent-session-handoff'
import { recoverDeadTuiHandoffStatus } from './structured-agent-session-dead-tui-recovery'
import { acquireNativeHandoffOwner } from './structured-agent-session-native-handoff-acquisition'
import type { AgentSessionSubscribers } from './structured-agent-session-subscribers'
import { StructuredTuiTranscriptCatchup } from './structured-tui-transcript-catchup'
import { retryLoadedStructuredAgentSessionSettlement } from './structured-agent-session-settlement-retry'
import { latestJournalDispatchObservation } from '../agent-session-journal/journal-dispatch-observation'

export type HostHandoffAccess = {
  session: (sessionId: string) => StructuredAgentSessionHostSession
  /** Non-throwing lookup, for the paths that only observe a detached session. */
  findSession: (sessionId: string) => StructuredAgentSessionHostSession | undefined
  eventSinks: Pick<
    StructuredAgentSessionHostRuntimeState,
    'eventSinkFor' | 'mintEventSink' | 'adoptEventSink'
  >
  flush: (sessionId: string) => Promise<void>
  serialize: (sessionId: string, task: () => Promise<void>) => Promise<void>
  subscribers: AgentSessionSubscribers
  publishStatus?: (sessionId: string) => void
  now: () => number
}

export type StructuredAgentSessionHostHandoff = StructuredAgentSessionHandoffCoordinator & {
  stopTuiHistoryCatchup: () => void
  recoverDeadTuiOwner: (
    sessionId: string,
    expectedFence: number,
    probe: AgentSessionOwnerProbe
  ) => Promise<void>
}

export async function refreshRecoverableStructuredHandoffStatus(
  handoff: StructuredAgentSessionHostHandoff,
  store: StructuredAgentSessionHostDeps['store'],
  sessionId: string
) {
  const record = store.getRecord(sessionId)
  if (record && canRestoreLiveTuiOwner(record)) {
    await handoff.restore(sessionId)
  }
  return handoff.status(sessionId)
}

export function createStructuredAgentSessionHostHandoff(
  deps: StructuredAgentSessionHostDeps,
  host: HostHandoffAccess
): StructuredAgentSessionHostHandoff {
  const tuiHistoryCatchup = new StructuredTuiTranscriptCatchup({
    store: deps.store,
    session: host.session,
    schedule: host.serialize,
    publish: (sessionId) => {
      const session = host.session(sessionId)
      host.subscribers.publish(sessionId, session.journal)
    },
    reset: (sessionId, fence) => {
      const session = host.session(sessionId)
      host.subscribers.reset(sessionId, session.journal, 'epoch_changed', fence)
    },
    ...(deps.onEventSinkError ? { onError: deps.onEventSinkError } : {})
  })
  const coordinator = new StructuredAgentSessionHandoffCoordinator({
    store: deps.store,
    claimKeyId: deps.claimKeyId,
    ...(deps.handoffTransport ? { transport: deps.handoffTransport } : {}),
    session: host.session,
    suspendNative: async (sessionId) => {
      if (!deps.adapter.closeSession) {
        return { state: 'live' }
      }
      const exited = await deps.adapter.closeSession(sessionId)
      if (exited !== true) {
        // Report the unproven exit; the forward handoff refuses on it.
        return { state: 'live' }
      }
      host.session(sessionId).hasProviderChild = false
      host.publishStatus?.(sessionId)
      try {
        await host.flush(sessionId)
        const session = host.session(sessionId)
        await session.journal.markPendingSubmissionsUnknown(
          session.fence,
          'provider_exited_before_acknowledgement'
        )
        host.subscribers.publish(sessionId, session.journal)
        host.publishStatus?.(sessionId)
        host.eventSinks.eventSinkFor(sessionId).unbind()
        return { state: 'stopped' }
      } catch (error) {
        return { state: 'stopped-cleanup-failed', error }
      }
    },
    acknowledgeNativeRelease: (sessionId) => deps.adapter.acknowledgeSessionRelease?.(sessionId),
    acquireNative: (input) => acquireNativeHandoffOwner(deps, host, input),
    acquireNativeStop: (sessionId, turnId, fence) =>
      stopNativeHandoffTurn(deps.adapter, host.session(sessionId), { sessionId, turnId, fence }),
    importTuiHistory: (input) => importTuiHistory(deps, host, input),
    retryPendingSettlement: (sessionId) =>
      retryLoadedStructuredAgentSessionSettlement({
        deps,
        sessionId,
        session: host.session(sessionId),
        now: host.now
      }),
    prepareTuiHistoryCatchup: (sessionId, fence) => tuiHistoryCatchup.prepare(sessionId, fence),
    recoverTuiHistoryCatchup: (sessionId, fence) => tuiHistoryCatchup.recover(sessionId, fence),
    activateTuiHistoryCatchup: (sessionId) => tuiHistoryCatchup.activate(sessionId),
    stopTuiHistoryCatchup: (sessionId) => tuiHistoryCatchup.stop(sessionId),
    publish: (sessionId, status) => {
      // A status publish is a notification, not a mutation. Eviction and host teardown both drop
      // the session while a handoff flow is still settling, and `requireSession` would turn that
      // last publish — usually the FAILED one — into an unhandled rejection nothing can catch.
      const fence =
        deps.store.getRecord(sessionId)?.lease.runtimeFence ?? host.findSession(sessionId)?.fence
      if (fence === undefined) {
        return
      }
      host.subscribers.handoff(sessionId, fence, status)
    },
    schedule: host.serialize,
    now: host.now,
    ...(deps.persistTuiProviderHandle
      ? { persistTuiProviderHandle: deps.persistTuiProviderHandle }
      : {})
  })
  return Object.assign(coordinator, {
    stopTuiHistoryCatchup: () => tuiHistoryCatchup.stopAll(),
    recoverDeadTuiOwner: async (
      sessionId: string,
      expectedFence: number,
      probe: AgentSessionOwnerProbe
    ) => {
      const record = deps.store.getRecord(sessionId)
      if (!record) {
        return
      }
      const status = await recoverDeadTuiHandoffStatus({
        store: deps.store,
        now: host.now,
        record,
        expectedFence,
        probe
      })
      if (status) {
        coordinator.setStatus(sessionId, status)
      }
    }
  })
}

/** Handoff's own Stop, which never passes through `performCancel` and so has to carry the
 *  journal reads that judge a cancellation itself. */
export async function stopNativeHandoffTurn(
  adapter: Pick<StructuredAgentSessionAdapter, 'cancelTurn'>,
  session: Pick<StructuredAgentSessionHostSession, 'journal'>,
  input: { sessionId: string; turnId: string; fence: number }
): Promise<boolean> {
  const dispatchStatus = latestJournalDispatchObservation(session.journal, input.fence)
  return (
    await adapter.cancelTurn({
      ...input,
      // The journal is what the client read to name a turn, so it is what judges the request.
      resolveLiveTurnId: () => session.journal.activeTurnId(),
      ...(dispatchStatus ? { dispatchStatus } : {})
    })
  ).cancelled
}

async function importTuiHistory(
  deps: StructuredAgentSessionHostDeps,
  host: HostHandoffAccess,
  input: { sessionId: string; fence: number; transcriptPath?: string }
): Promise<void> {
  const session = host.session(input.sessionId)
  const record = deps.store.getRecord(input.sessionId)
  const head = record?.providerHandleChain.at(-1)
  if (!record || !head) {
    throw new Error('agent_session_identity_required')
  }
  const options = structuredTuiTranscriptImportOptions(record, input.transcriptPath)
  const providerSessionId =
    head.handle.provider === 'claude' ? head.handle.sessionId : head.handle.threadId
  const imported = await importLegacyTranscriptIntoJournal({
    journal: session.journal,
    agent: head.handle.provider,
    sessionId: providerSessionId,
    fence: input.fence,
    options
  })
  if (!imported.ok) {
    throw new Error(imported.error)
  }
  host.subscribers.reset(input.sessionId, session.journal, 'epoch_changed', input.fence)
}

export function structuredTuiTranscriptImportOptions(
  record: AgentSessionRecord,
  transcriptPath?: string
): LegacyImportOptions {
  if (transcriptPath) {
    return { filePath: transcriptPath }
  }
  return record.provider === 'claude'
    ? { claudeProjectsDir: join(record.accountHome.path, 'projects') }
    : { codexSessionsDirs: [join(record.accountHome.path, 'sessions')] }
}
