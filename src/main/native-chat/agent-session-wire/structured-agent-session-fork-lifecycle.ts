import { isDeepStrictEqual } from 'node:util'
import { agentSessionForkAnchor } from '../../../shared/agent-session-fork'
import type {
  AgentSessionForkRecord,
  AgentSessionForkTarget
} from '../../../shared/agent-session-fork'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { isAdmissibleAgentJournalItemBody } from '../../../shared/agent-session-journal-schemas'
import {
  agentSessionProviderHandleKey,
  appendAgentSessionProviderHandleLink,
  type AgentSessionProviderHandleLink
} from '../../../shared/agent-session-provider-handle'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { agentSessionJournalCloseRetries } from '../agent-session-journal/journal-close-retry'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { forkJournalSeed } from './structured-fork-journal-seed'

export async function beginStructuredForkAttempt(
  store: AgentSessionRecordStore,
  record: AgentSessionRecord
): Promise<AgentSessionForkTarget | undefined> {
  const fork = record.fork
  if (!fork || fork.phase === 'provider-succeeded' || fork.phase === 'completed') {
    return undefined
  }
  if (fork.phase !== 'prepared') {
    throw new Error('agent_session_operation_unknown')
  }
  await store.transitionHandoff(record.sessionId, (current) => {
    if (
      current.lease.runtimeFence !== record.lease.runtimeFence ||
      current.fork?.phase !== 'prepared'
    ) {
      throw new Error('agent_session_checkpoint_stale')
    }
    return { ...current, fork: { ...fork, phase: 'attempted' } }
  })
  return {
    source: fork.source,
    throughId: fork.throughId,
    retainedItemIds: fork.retained.map((item) => item.itemId)
  }
}

/**
 * Settle an attempt that provably never reached the provider.
 *
 * Without a terminal for this case the record stays `attempted` forever: every later attach throws
 * `agent_session_operation_unknown` and replay deliberately skips the phase, so the child is
 * wedged. Clearing `retained` matters just as much — the store re-serializes in full on every
 * lease renewal, so a stranded prefix is rewritten every few seconds for the life of the record.
 *
 * Only a proven pre-provider failure may settle here. An ambiguous one must keep `attempted` and
 * refuse a second attempt rather than risk a second provider session.
 */
export async function refuseStructuredForkAttempt(
  store: AgentSessionRecordStore,
  record: AgentSessionRecord,
  reason: string
): Promise<void> {
  const fork = store.getRecord(record.sessionId)?.fork
  if (fork?.phase !== 'attempted') {
    return
  }
  await store.transitionHandoff(record.sessionId, (current) => {
    if (
      current.lease.runtimeFence !== record.lease.runtimeFence ||
      current.fork?.phase !== 'attempted'
    ) {
      throw new Error('agent_session_checkpoint_stale')
    }
    return {
      ...current,
      fork: { ...current.fork, phase: 'refused', reason: reason.slice(0, 512), retained: [] }
    }
  })
}

/** Re-arm a refused fork. The retry re-derives the prefix from the parent, because settling the
 *  refusal dropped the stranded copy. */
export function restartRefusedStructuredFork(
  store: AgentSessionRecordStore,
  sessionId: string,
  fork: AgentSessionForkRecord
): Promise<unknown> {
  return store.transitionHandoff(sessionId, (current) => {
    if (current.fork?.phase !== 'refused') {
      throw new Error('agent_session_checkpoint_stale')
    }
    // Merged, not replaced: the replay that preceded this stamped the recovery operation ids.
    return { ...current, fork: { ...current.fork, ...fork, phase: 'prepared' } }
  })
}

export function proveStructuredForkAcquisition(
  record: AgentSessionRecord,
  acquired: AgentSessionProviderHandleLink
): AgentSessionProviderHandleLink {
  const fork = record.fork
  if (!fork || fork.phase === 'completed' || fork.phase === 'provider-succeeded') {
    return acquired
  }
  const link: AgentSessionProviderHandleLink = {
    ...acquired,
    origin: 'forked',
    forkedFromKey: agentSessionProviderHandleKey(fork.source)
  }
  appendAgentSessionProviderHandleLink(
    [agentSessionForkAnchor(fork.source, record.lease.runtimeFence, record.createdAt)],
    link
  )
  return link
}

export async function publishStructuredForkJournal(
  store: AgentSessionRecordStore,
  record: AgentSessionRecord,
  journal: AgentSessionJournal
): Promise<void> {
  const fork = record.fork
  if (!fork || fork.phase === 'completed') {
    return
  }
  try {
    const head = record.providerHandleChain.at(-1)
    if (
      fork.phase !== 'provider-succeeded' ||
      !head ||
      !record.providerHandleChain.some((link) => link.origin === 'forked')
    ) {
      throw new Error('agent_session_operation_unknown')
    }
    const items = fork.retained.map((item) => {
      if (!isAdmissibleAgentJournalItemBody(item.body)) {
        throw new Error('agent_session_operation_invalid')
      }
      return { ...item, body: item.body }
    })
    const seed = forkJournalSeed(items, fork.source, head.handle)
    // A crash after the journal transaction must settle its existing epoch, not replace it twice.
    // The child journal is opened and seeded before its event sink is bound, so on re-entry it
    // holds exactly the seed; anything else means the child moved on and must not be overwritten.
    const landed = journal.snapshot().items.map(({ itemId, body }) => ({ itemId, body }))
    if (landed.length > 0) {
      if (
        !isDeepStrictEqual(
          landed,
          seed.map(({ identity, body }) => ({ itemId: agentJournalItemKey(identity), body }))
        )
      ) {
        throw new Error('agent_session_operation_invalid')
      }
    } else {
      await journal.replaceEpochItems('handle_forked', record.lease.runtimeFence, seed)
    }
    await store.transitionHandoff(record.sessionId, (current) => {
      if (
        current.lease.runtimeFence !== record.lease.runtimeFence ||
        current.fork?.phase !== 'provider-succeeded'
      ) {
        throw new Error('agent_session_checkpoint_stale')
      }
      return { ...current, schemaVersion: 2, fork: { ...fork, phase: 'completed', retained: [] } }
    })
  } catch (error) {
    await agentSessionJournalCloseRetries.closeOrRetain(journal)
    throw error
  }
}
