// Count pending handovers and late-settlement writes as held until child/journal state catches up.
// Nested late-settlement windows share the count without replacing the input that owns its result.

import type { AgentJournalSubmission } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { UnsentSendHold } from '../../agent-session-journal/queued-messages/journal-unsent-send-hold'
import type { AgentSessionJournal } from '../../agent-session-journal/journal-store'
import type { UnopenedSendJournal } from './structured-agent-session-unopened-send-withdrawal'

/** Live handles and finite recovery snapshots identify their own handover windows. */
type HandoverJournal = AgentSessionJournal | Pick<UnopenedSendJournal, 'snapshot' | 'submission'>

type HandoverInput = {
  owner: () => void
  unadmitted: boolean
  compilerPermission?: 'auto'
  signal?: AbortSignal
  pending?: () => boolean
  finalization: { close: (cause: UnsentSendHold['cause']) => void; completion: Promise<void> }
}
type Handover = { count: number; input?: HandoverInput }
const handingOver = new WeakMap<HandoverJournal, Map<string, Handover>>()
const NONE: ReadonlyMap<string, Handover> = new Map()

/** Cancellation retains outcome responsibility; its exact owner may bypass doubt delegation. */
export function finalizingStructuredAgentSessionInput(
  journal: HandoverJournal,
  clientMessageId: string,
  except?: () => void
): boolean {
  const input = handingOver.get(journal)?.get(clientMessageId)?.input
  return input?.finalization !== undefined && input.owner !== except
}

/** Close cooperates with the existing result owner without joining it under host ordering. */
export function closeStructuredAgentSessionHandovers(
  journal: HandoverJournal,
  cause: UnsentSendHold['cause'] = 'chatClosed'
): Promise<void> | undefined {
  const finalizers = [...(handingOver.get(journal)?.values() ?? [])].flatMap(
    (entry) => entry.input?.finalization ?? []
  )
  if (finalizers.length === 0) {
    return undefined
  }
  for (const finalizer of finalizers) {
    finalizer.close(cause)
  }
  return Promise.all(finalizers.map((input) => input.completion)).then(() => {})
}

/** The sends this journal's chat is handing over now. */
export function structuredAgentSessionHandingOver(
  journal: HandoverJournal
): ReadonlyMap<string, Handover> {
  return handingOver.get(journal) ?? NONE
}

/** Pending submission membership is checked in the reader's snapshot, alongside these live owners. */
export function structuredAgentSessionHandoverAuthority(journal: HandoverJournal): {
  handingOver: string[]
  continuingUnadmitted: string[]
  finalizing: string[]
} {
  const sends = structuredAgentSessionHandingOver(journal)
  const continuingUnadmitted: string[] = []
  const finalizing: string[] = []
  for (const [id, { input }] of sends) {
    if (input?.unadmitted === true && input.signal?.aborted !== true) {
      continuingUnadmitted.push(id)
    }
    if (input?.finalization !== undefined) {
      finalizing.push(id)
    }
  }
  return { handingOver: [...sends.keys()], continuingUnadmitted, finalizing }
}

/** Volatile proof owned by the live handover; a crash or cancellation restores ordinary doubt. */
export function continuingStructuredAgentSessionInput(
  journal: HandoverJournal,
  clientMessageId: string
): boolean {
  const input = handingOver.get(journal)?.get(clientMessageId)?.input
  return input?.unadmitted === true && input.signal?.aborted !== true && (input.pending?.() ?? true)
}

export function markStructuredAgentSessionInputUnadmitted(
  journal: HandoverJournal,
  clientMessageId: string,
  owner: () => void,
  unadmitted: boolean,
  signal?: AbortSignal,
  compilerPermission?: 'auto'
): void {
  const input = handingOver.get(journal)?.get(clientMessageId)?.input
  if (input?.owner === owner) {
    Object.assign(input, {
      unadmitted,
      compilerPermission,
      signal,
      ...(hasSubmissionSnapshot(journal)
        ? { pending: () => journal.submission(clientMessageId)?.dispatchState === 'pending' }
        : {})
    })
  }
}

export function continuingStructuredAgentSessionCompilerPermission(
  journal: HandoverJournal,
  clientMessageId: string
): 'auto' | undefined {
  return continuingStructuredAgentSessionInput(journal, clientMessageId)
    ? handingOver.get(journal)?.get(clientMessageId)?.input?.compilerPermission
    : undefined
}

/** Runs one handover with its send counted as held, from before its pending row until the adapter
 *  answered; `released` then republishes what is current, which no row may follow. */
export async function whileStructuredAgentSessionHandingOver<T>(
  journal: HandoverJournal,
  clientMessageId: string,
  handOver: (released: () => void) => Promise<T>,
  workChanged?: () => void
): Promise<T> {
  const released = beginStructuredAgentSessionHandover(journal, clientMessageId, workChanged)
  try {
    return await handOver(released)
  } finally {
    released()
  }
}

/** Span separate pending-row/provider-call steps with the same held window. */
export function beginStructuredAgentSessionHandover(
  journal: HandoverJournal,
  clientMessageId: string,
  workChanged?: () => void,
  finalization?: { close: (cause: UnsentSendHold['cause']) => void }
): () => void {
  let sends = handingOver.get(journal)
  if (!sends) {
    sends = new Map()
    handingOver.set(journal, sends)
  }
  const entry: Handover = sends.get(clientMessageId) ?? { count: 0 }
  entry.count += 1
  sends.set(clientMessageId, entry)
  let held = true
  const completed = Promise.withResolvers<void>()
  const release = (): void => {
    if (held) {
      held = false
      if (entry.input?.owner === release) {
        delete entry.input
      }
      entry.count -= 1
      if (entry.count === 0) {
        sends.delete(clientMessageId)
      }
      try {
        workChanged?.()
      } finally {
        completed.resolve()
      }
    }
  }
  if (finalization) {
    entry.input = {
      owner: release,
      unadmitted: false,
      finalization: { ...finalization, completion: completed.promise }
    }
  }
  return release
}

/** Finite policy snapshots retain their synchronous membership check. Live handles read it in-worker. */
function hasSubmissionSnapshot(
  journal: HandoverJournal
): journal is HandoverJournal & { submission: (id: string) => AgentJournalSubmission | undefined } {
  return 'submission' in journal && typeof journal.submission === 'function'
}
