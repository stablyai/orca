import { randomUUID } from 'node:crypto'
import { agentSessionProviderHandleChainHead } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle'
import { agentSessionProviderHandleKey } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import type { AgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-record'
import type { AgentSessionRecordStore } from '../../runtime/agent-session/records/agent-session-record-store'
import { recordAgentSessionProviderHandle } from '../../runtime/agent-session/ownership/agent-session-provider-handle-transition'
import { requireWritableAgentSessionRecord } from '../../runtime/agent-session/records/agent-session-store-state'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  readContextTransfers,
  writeContextTransfer
} from '../agent-session-journal/context-transfer-repository'
import { deriveContextTransferState } from '../agent-session-journal/context-transfer-state'
import type { RecoveryConstructionPermit } from './structured-agent-session-construction'
import type { StructuredAgentSessionProviderOpenResult } from './structured-agent-session-provider-open-contract'
import type { StructuredAgentSessionProviderStartedContext } from './structured-agent-session-provider-started'

export type OpenedProvider = StructuredAgentSessionProviderOpenResult & {
  sessionId: string
  fence: number
  acquisitionGeneration: string
  recoveryPermit?: RecoveryConstructionPermit
}

export async function publishNativeRecovery(input: {
  store: AgentSessionRecordStore
  journal: AgentSessionJournal
  sessionId: string
  fence: number
  generation: string
  permit: RecoveryConstructionPermit
  result: StructuredAgentSessionProviderOpenResult
  now: number
}): Promise<AgentSessionRecord> {
  const { result, store, journal, sessionId, fence, generation, now, permit } = input
  const link = result.link
  if (!link) {
    throw new Error('Recovered native session did not name its target')
  }
  let committed: AgentSessionRecord | undefined
  const receipt = store.recordReceipt((draft) => {
    const record = requireWritableAgentSessionRecord(draft, sessionId)
    const records = journal.contextTransfers.read()
    const state = deriveContextTransferState(records, record.providerHandleChain)
    const target = state.kind === 'unpublished' ? state.target : undefined
    const source = agentSessionProviderHandleChainHead(record.providerHandleChain)
    if (
      !target ||
      target.id !== permit.targetAttemptId ||
      target.handoffId !== permit.handoffId ||
      target.sourceLinkId !== permit.sourceLinkId ||
      permit.fence !== fence ||
      target.targetLink ||
      target.fence !== fence ||
      source?.linkId !== target.sourceLinkId
    ) {
      throw new Error('Recovery target changed before publication')
    }
    const prior = records.find(
      (row) => row.kind === 'target' && row.id === target.predecessorTargetId
    )
    const key = agentSessionProviderHandleKey(source.handle)
    const recovered = {
      ...link,
      origin: 'created' as const,
      ...(prior?.kind === 'target' &&
      prior.firstInputId === null &&
      prior.targetLink?.origin === 'created' &&
      records.some(
        (row) =>
          row.kind === 'handoff' &&
          row.id === target.handoffId &&
          (row.id === prior.handoffId || row.supersedesHandoffId === prior.handoffId)
      ) &&
      !journal
        .submissions()
        .some(
          (row) =>
            row.fence >= prior.fence &&
            (row.handedOverAt !== undefined || row.dispatchState === 'unknown')
        ) &&
      prior.targetLink &&
      agentSessionProviderHandleKey(prior.targetLink.handle) === key
        ? { supersedesKey: key, ...(source.replaces ? { replaces: source.replaces } : {}) }
        : { replaces: { key, reason: 'restore-failed' as const, replacedAt: now } })
    }
    committed = recordAgentSessionProviderHandle({ record, fence, link: recovered, now })
    draft.records.set(sessionId, committed)
  })
  await store.commitOperationReceipt({
    write: (db, row) => {
      receipt.write(db, row)
      const records = readContextTransfers(db, sessionId)
      const target = records.find(
        (row) => row.kind === 'target' && row.id === permit.targetAttemptId
      )
      const published =
        committed && agentSessionProviderHandleChainHead(committed.providerHandleChain)
      if (target?.kind !== 'target' || !published) {
        throw new Error('Recovery publication lost its target')
      }
      writeContextTransfer(db, {
        ...target,
        targetLink: published,
        acquisitionGeneration: generation
      })
      const handoff = records.find((row) => row.kind === 'handoff' && row.id === target.handoffId)
      if (handoff?.kind === 'handoff' && handoff.capture.coverage.eligibleCount === 0) {
        writeContextTransfer(db, {
          kind: 'delivery',
          id: randomUUID(),
          sessionId,
          handoffId: handoff.id,
          targetId: target.id,
          mode: 'none',
          carrierInputId: null,
          preparedAt: now,
          selection: {
            itemIds: [],
            omittedCount: 0,
            coverageText: '',
            encodedContext: '',
            digest: handoff.capture.coverage.inventoryDigest,
            encodingVersion: 1
          },
          outcome: { kind: 'not-required', at: now }
        })
      }
    },
    committed: () => receipt.committed()
  })
  if (!committed) {
    throw new Error('Recovery handle was not committed')
  }
  return committed
}

/** Persist the opened handle before delivery so future starts can resume; false if no handle is proven. */
export async function recordStartedHandle(
  context: StructuredAgentSessionProviderStartedContext,
  event: OpenedProvider
): Promise<boolean> {
  const { store, logger } = context.deps
  const { link } = event
  if (!link) {
    // Only an already-proven handle permits open without a new link.
    return store.getRecord(event.sessionId)?.lease.provenHandleLinkId != null
  }
  try {
    const journal = context.sessions.get(event.sessionId)?.journal
    const state =
      journal &&
      deriveContextTransferState(
        journal.contextTransfers.read(),
        store.requireWritableRecord(event.sessionId).providerHandleChain
      )
    if (!event.recoveryPermit && state?.kind === 'unpublished') {
      throw new Error('Ordinary construction cannot publish a prepared recovery attempt')
    }
    const committed =
      event.recoveryPermit && journal
        ? await publishNativeRecovery({
            store,
            journal,
            sessionId: event.sessionId,
            fence: event.fence,
            generation: event.acquisitionGeneration,
            result: event,
            permit: event.recoveryPermit,
            now: context.now()
          })
        : await store.transitionHandoff(event.sessionId, (record) =>
            recordAgentSessionProviderHandle({
              record,
              fence: event.fence,
              link,
              now: context.now()
            })
          )
    // Inherit only a committed new context; a resumed CLI keeps its own later title.
    if (event.newConversation ?? (link.origin === 'created' || link.origin === 'forked')) {
      context.deps.nameProviderConversation?.(committed)
    }
    return true
  } catch (error) {
    logger.warn('recording the handle a started provider answered with failed', {
      scope: 'provider-started-handle',
      sessionId: event.sessionId,
      error
    })
    return false
  }
}
