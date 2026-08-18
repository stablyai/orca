// Where an adapter writes the provider events it did not synchronously return.
//
// A provider starts streaming the moment its process exists, and that moment is
// INSIDE `adapter.acquire` — before the journal is open and before the host has
// registered the session. So the sink an adapter receives is deferred: writes
// queue in arrival order and drain once the journal exists.
//
// One sink lives for the session, not for one acquisition: a re-attach opens a
// NEW journal object at a NEW fence, and rebinding re-points the same sink at
// it. That keeps a single identity for the adapter to hold across a re-acquire,
// and the adapter closes the superseded child, so nothing writes behind a fence
// that has already moved.

import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { putJournalBlob, removeJournalBlob } from '../agent-session-journal/journal-blob-store'

export type StructuredAgentSessionJournalBlob = { digest: string; payload: string }

/** The only journal surface an adapter gets: append and publish, no reads. An
 *  adapter that could read the journal would start reconciling against it, and
 *  reconciliation is the wire's job, not the provider's. */
export type StructuredAgentSessionEventSink = {
  appendItem(
    identity: AgentJournalItemIdentity,
    body: AgentJournalItemBody,
    blobs?: readonly StructuredAgentSessionJournalBlob[]
  ): void
  appendTombstone(identity: AgentJournalItemIdentity): void
  /** Fan the journal out to subscribers. Cheap and idempotent. */
  publish(): void
}

export type StructuredAgentSessionEventTarget = {
  journal: AgentSessionJournal
  /** Fence the sink writes at. Fixed for the life of the sink: a new fence
   *  means a new acquisition, which gets its own sink. */
  fence: number
  publish: () => void
}

export type DeferredStructuredAgentSessionEventSink = {
  sink: StructuredAgentSessionEventSink
  /** Drains everything buffered so far, in order, then writes through. Called
   *  again on every re-attach to re-point the sink at the new journal. */
  bind(target: StructuredAgentSessionEventTarget): void
  /** Queues new provider events until a replacement journal is bound. */
  unbind(): void
  /** Permanently stops the sink. Queued writes are dropped rather than landing
   *  in a journal the host has already let go of. */
  close(): void
  /** Resolves once every write queued so far has landed. */
  drained(): Promise<void>
}

type SinkOperation = (target: StructuredAgentSessionEventTarget) => Promise<unknown> | void

export function createDeferredStructuredAgentSessionEventSink(
  deps: {
    /** A rejected append. Unset drops it: throwing here would surface inside the
     *  provider's notification callback and take the connection down, and the
     *  lease already guarantees a stale writer's rows are refused. */
    onError?: (error: unknown) => void
  } = {}
): DeferredStructuredAgentSessionEventSink {
  let target: StructuredAgentSessionEventTarget | null = null
  let closed = false
  const buffered: SinkOperation[] = []
  let chain: Promise<void> = Promise.resolve()

  const enqueue = (operation: SinkOperation): void => {
    const bound = target
    chain = chain.then(async () => {
      try {
        await operation(bound as StructuredAgentSessionEventTarget)
      } catch (error) {
        deps.onError?.(error)
      }
    })
  }

  const submit = (operation: SinkOperation): void => {
    if (closed) {
      return
    }
    if (!target) {
      buffered.push(operation)
      return
    }
    enqueue(operation)
  }

  return {
    sink: {
      appendItem: (identity, body: AgentJournalItemBody, blobs = []) => {
        submit(async (bound) => {
          const persisted: string[] = []
          try {
            for (const blob of blobs) {
              await putJournalBlob(bound.journal.directory, blob.digest, blob.payload)
              persisted.push(blob.digest)
            }
            await bound.journal.appendItem(identity, body, { fence: bound.fence })
          } catch (error) {
            const retained = bound.journal.referencedBlobDigests?.() ?? new Set<string>()
            for (const digest of persisted) {
              if (!retained.has(digest)) {
                await removeJournalBlob(bound.journal.directory, digest)
              }
            }
            throw error
          }
        })
      },
      appendTombstone: (identity) => {
        submit((bound) => bound.journal.appendTombstone(identity, { fence: bound.fence }))
      },
      publish: () => {
        submit((bound) => bound.publish())
      }
    },
    bind: (next) => {
      if (closed) {
        return
      }
      target = next
      const pending = buffered.splice(0)
      for (const operation of pending) {
        enqueue(operation)
      }
    },
    unbind: () => {
      target = null
    },
    close: () => {
      closed = true
      buffered.length = 0
    },
    drained: () => chain
  }
}
