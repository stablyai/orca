import type { StructuredAgentSessionExpiredStartup } from './structured-agent-session-startup-attempt'
import type { AgentJournalSubmission } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession,
  StructuredAgentSessionProviderChildIdentity,
  StructuredAgentSessionProviderChild
} from './structured-agent-session-host-types'
import type { StructuredAgentSessionClientDelivery } from './structured-agent-session-client-delivery'
import { retireOutgrownStructuredAgentSessionChild } from './structured-agent-session-outgrown-child'
import {
  structuredAgentSessionInputCompilerPermission,
  structuredAgentSessionLaunchPermission
} from './structured-agent-session-launch-permission'
import type { StructuredAgentSessionConversationLifetimeHost } from './structured-agent-session-conversation-lifetime-host'
import type { StructuredAgentSessionStopEnding } from './structured-agent-session-host-lifetime'
import { sameProviderChild } from './structured-agent-session-provider-child'
import { agentSessionProviderHandleChainHead } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle'
import type { AgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-record'
import type { AgentSessionRecordStore } from '../../runtime/agent-session/records/agent-session-record-store'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { deriveContextTransferState } from '../agent-session-journal/context-transfer-state'
import { prepareNativeRecovery } from './structured-agent-session-recovery'

export function recoveryContinuationRequired(
  journal: AgentSessionJournal,
  record: AgentSessionRecord
): boolean {
  const state = deriveContextTransferState(
    journal.contextTransfers.facts(),
    record.providerHandleChain
  )
  return state.kind === 'uncertain' || state.kind === 'unpublished'
}

/** Both startup and ready-child continuation retire through the existing lifetime owner. */
export async function continueNativeRecovery(input: {
  store: AgentSessionRecordStore
  journal: AgentSessionJournal
  record: AgentSessionRecord
  child: StructuredAgentSessionProviderChild
  busy: boolean
  now: number
  stop: () => Promise<void>
}): Promise<boolean> {
  const { store, journal, record, child } = input
  if (
    input.busy ||
    child.close ||
    child.fence !== record.lease.runtimeFence ||
    !recoveryContinuationRequired(journal, record)
  ) {
    return false
  }
  const source = agentSessionProviderHandleChainHead(record.providerHandleChain)
  if (!source) {
    throw new Error('Recovery continuation lost its source')
  }
  prepareNativeRecovery({
    store,
    journal,
    record,
    source,
    trigger: 'uncertain-context-delivery',
    now: input.now
  })
  child.recoveryContinuation = true
  await input.stop()
  return true
}

export function createStartingRecoveryLifetime(
  host: StructuredAgentSessionConversationLifetimeHost,
  stopAgent: (sessionId: string, ending: StructuredAgentSessionStopEnding) => Promise<void>,
  stopStartingChild: (
    sessionId: string,
    child: StructuredAgentSessionProviderChildIdentity | null
  ) => void
) {
  return {
    expireStartup: ({ sessionId, child }: StructuredAgentSessionExpiredStartup): void =>
      stopStartingChild(sessionId, child),
    continueStartingChild: async (
      sessionId: string,
      expected: StructuredAgentSessionProviderChildIdentity
    ): Promise<void> => {
      const child = host.sessions.get(sessionId)?.child
      if (
        !child ||
        child.close ||
        child.phase !== 'starting' ||
        !sameProviderChild(child, expected)
      ) {
        throw new Error('Recovery construction lost its child')
      }
      child.recoveryContinuation = true
      host.context().runtimeState.startupAttempts.continueConstruction(sessionId, child)
      await stopAgent(sessionId, { cause: 'evict', resting: true })
    }
  }
}

export async function retireDeliveryChild(
  input: {
    deps: StructuredAgentSessionHostDeps
    sessions: Map<string, StructuredAgentSessionHostSession>
    clientDelivery: Pick<StructuredAgentSessionClientDelivery, 'readStopping'>
    stopOutgrownAgent: (sessionId: string) => Promise<void>
    retainedWork: (
      sessionId: string,
      continuingId?: string
    ) => Parameters<typeof retireOutgrownStructuredAgentSessionChild>[2]['work']
  },
  sessionId: string,
  continuingId?: string,
  next?: AgentJournalSubmission
) {
  const { deps, sessions, retainedWork } = input
  // Defer retirement while personal Stop holds handover; its next step decides.
  const session = input.clientDelivery.readStopping(sessionId) ? undefined : sessions.get(sessionId)
  const record = deps.store.getRecord(sessionId)
  const head = record && agentSessionProviderHandleChainHead(record.providerHandleChain)
  const child = session?.child
  const recoveryRequired = !!(
    session &&
    child?.phase === 'ready' &&
    !child.close &&
    child.fence === record?.lease.runtimeFence &&
    head &&
    record &&
    recoveryContinuationRequired(session.journal, record)
  )
  await retireOutgrownStructuredAgentSessionChild(sessionId, session, {
    recoveryRequired,
    next,
    requiresModelTransitionRestart: (submission) =>
      session?.child?.phase === 'ready' &&
      deps.adapter.requiresModelTransitionRestart?.({
        sessionId,
        fence: session.child.fence,
        executionOptions: submission.options
      }) === true,
    work: retainedWork(sessionId, continuingId),
    launchPermission: async () => {
      const record = deps.store.getRecord(sessionId)
      return (
        structuredAgentSessionInputCompilerPermission(session?.journal, continuingId) ??
        (record ? structuredAgentSessionLaunchPermission(deps, record) : null)
      )
    },
    permissionRequiresAcquisition: (mode) =>
      continuingId
        ? true
        : (deps.adapter.permissionModeRequiresAcquisition?.(sessionId, mode) ??
          mode !== session?.child?.permissionMode),
    stopAgent: async (sessionId) => {
      if (!recoveryRequired) {
        return input.stopOutgrownAgent(sessionId)
      }
      if (!session || !child || session.child !== child) {
        throw new Error('Recovery retirement lost its child')
      }
      await continueNativeRecovery({
        store: deps.store,
        journal: session.journal,
        record: deps.store.requireWritableRecord(sessionId),
        child,
        busy: false,
        now: deps.now?.() ?? Date.now(),
        stop: () => input.stopOutgrownAgent(sessionId)
      })
    },
    launchAccountHome: async () => {
      const record = deps.store.getRecord(sessionId)
      return record ? ((await deps.launchAccountHome?.(record, 'identity')) ?? null) : null
    },
    logger: deps.logger
  })
  // Completion receipts wake the ordinary delivery loop; no speculative resend or retry spin.
  if (recoveryRequired && session?.child === child && !child?.close) {
    return 'waiting' as const
  }
  return undefined
}
