import {
  AGENT_SESSION_QUEUE_SUMMARY_MAX_BYTES,
  type AgentSessionQueueSummary
} from '../../../shared/agent-session-queue-pages'
import { stringifyJsonWithinByteLimit } from '../../../shared/node-bounded-json-stringify'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  readQueuePublicationFacts,
  sameQueuePause,
  type QueueSendGate,
  type QueuePublication
} from './structured-agent-session-queued-publication'

export type PagedQueuePublication = Pick<QueuePublication, 'queuePause' | 'nextQueuedMessageId'> & {
  queueSummary: AgentSessionQueueSummary
}
export type ReaderQueuePublication = QueuePublication | PagedQueuePublication
type SummaryMemo = { repositoryRevision: number; publication: PagedQueuePublication }
const summaries = new WeakMap<AgentSessionJournal, SummaryMemo>()

export function readQueueSummary(
  journal: AgentSessionJournal,
  gate: QueueSendGate
): PagedQueuePublication {
  const store = journal.queuedMessages.pages
  const generation = store.generation(journal.epoch)
  const repositoryRevision = journal.queuedMessages.revision()
  const previous = summaries.get(journal)
  const facts = readQueuePublicationFacts(journal, gate)
  const unchangedRows =
    previous?.repositoryRevision === repositoryRevision &&
    previous.publication.queueSummary.generation === generation
  if (
    unchangedRows &&
    sameQueuePause(previous.publication.queuePause, facts.queuePause) &&
    previous.publication.nextQueuedMessageId === facts.nextQueuedMessageId
  ) {
    return previous.publication
  }
  const counts = unchangedRows ? previous.publication.queueSummary.counts : store.counts()
  const queueSummary: AgentSessionQueueSummary = {
    generation,
    revision:
      previous && previous.publication.queueSummary.generation === generation
        ? Math.max(repositoryRevision, previous.publication.queueSummary.revision + 1)
        : repositoryRevision,
    total: counts.person + counts.agent + counts.unknown,
    counts,
    newestPersonMessageId: unchangedRows
      ? previous.publication.queueSummary.newestPersonMessageId
      : store.newestPersonMessageId(),
    blockingReturnedMessageId: unchangedRows
      ? previous.publication.queueSummary.blockingReturnedMessageId
      : store.blockingReturnedMessageId(),
    resumeAvailable: facts.queuePause !== null
  }
  stringifyJsonWithinByteLimit(queueSummary, AGENT_SESSION_QUEUE_SUMMARY_MAX_BYTES)
  const publication = { queueSummary, ...facts }
  summaries.set(journal, { repositoryRevision, publication })
  return publication
}

export function tryReadQueueSummary(
  journal: AgentSessionJournal | undefined,
  gate: QueueSendGate
): PagedQueuePublication | undefined {
  try {
    return journal ? readQueueSummary(journal, gate) : undefined
  } catch {
    return undefined
  }
}

export function queuePublicationFields(publication: ReaderQueuePublication) {
  return {
    ...('queueSummary' in publication
      ? { queueSummary: publication.queueSummary }
      : { queuedMessages: publication.queuedMessages }),
    queuePause: publication.queuePause,
    nextQueuedMessageId: publication.nextQueuedMessageId
  }
}
