import type { AgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-record'
import { sessionCrewChanges } from '../../runtime/orchestration/crew/crew-changes'
import type { StructuredAgentSessionHost } from '../agent-session-wire/host/structured-agent-session-host'
import type { JournalPublication } from '../agent-session-wire/host/structured-agent-session-conversations'
import type { AutomaticChatTitle } from './structured-chat-naming-types'

export function deferredStructuredChatTitle(input: {
  record: AgentSessionRecord
  firstInputSubmissionKey: string
  host: StructuredAgentSessionHost
  currentHost: () => StructuredAgentSessionHost | null
  applicable: () => boolean
  eligible: () => boolean
  subscribeSettings: (changed: () => void) => () => void
}): NonNullable<AutomaticChatTitle['pending']> {
  const { sessionId } = input.record
  const ready = Promise.withResolvers<AutomaticChatTitle['owner']>()
  const releases: (() => void)[] = []
  let settled = false
  let ended = false
  let publication: JournalPublication | undefined
  const release = (dispose: () => void) => (settled ? dispose() : releases.push(dispose))
  const settle = (owner: AutomaticChatTitle['owner'] = null) => {
    if (settled) {
      return
    }
    settled = true
    for (const dispose of releases.splice(0)) {
      dispose()
    }
    ready.resolve(owner)
  }
  const dispose = () => {
    ended = true
    settle()
  }
  const store = input.host.deps.store
  const recheck = () => {
    if (settled) {
      return
    }
    try {
      if (
        input.currentHost() !== input.host ||
        input.host.deps.store !== store ||
        !input.applicable()
      ) {
        dispose()
      } else if (!input.eligible()) {
        settle()
      }
    } catch {
      settle()
    }
  }
  const pending: NonNullable<AutomaticChatTitle['pending']> = {
    ready: ready.promise,
    ended: () => ended,
    recheck,
    unavailable: (journal) => {
      if (publication?.journal === journal) {
        settle()
      }
    },
    dispose
  }
  let key: unknown
  try {
    key = JSON.parse(input.firstInputSubmissionKey)
  } catch {
    settle()
  }
  if (
    !Array.isArray(key) ||
    key.length !== 2 ||
    typeof key[0] !== 'string' ||
    !key[0] ||
    typeof key[1] !== 'string' ||
    !key[1]
  ) {
    settle()
    return pending
  }
  const [epoch, clientMessageId] = key
  const abort = input.host.beginConversationTitleWait(sessionId)
  release(abort.end)
  const aborted = () => settle()
  abort.signal.addEventListener('abort', aborted, { once: true })
  release(() => abort.signal.removeEventListener('abort', aborted))
  if (abort.signal.aborted) {
    settle()
  }
  if (settled) {
    return pending
  }
  try {
    release(input.subscribeSettings(recheck))
    release(
      sessionCrewChanges.subscribe((facets) => {
        if (facets.has('topology') || facets.has('records')) {
          recheck()
        }
      })
    )
    release(
      input.host.observeConversationPublications(sessionId, {
        next: (hint) => {
          if (settled) {
            return
          }
          if (hint.kind === 'end') {
            dispose()
            return
          }
          recheck()
          if (settled) {
            return
          }
          if (
            hint.kind === 'detach' ||
            !hint.source ||
            !hint.journal ||
            hint.cursor?.epoch !== epoch
          ) {
            settle()
            return
          }
          if (publication && (publication.source !== hint.source || hint.kind === 'reset')) {
            settle()
            return
          }
          const submission = hint.journal.submission(clientMessageId)
          const card = submission?.queuedMessageId
            ? hint.journal.queuedMessages.get(submission.queuedMessageId)
            : undefined
          if (
            !submission ||
            submission.dispatchState !== 'pending' ||
            card?.holdReason ||
            card?.state === 'withdrawn' ||
            card?.state === 'returned'
          ) {
            settle()
            return
          }
          if (!publication) {
            publication = hint
            // A reset cannot prove which child first received an already handed-over input.
            if (
              hint.kind !== 'reset' ||
              submission.handedOverAt !== undefined ||
              !submission.handoverRecorded
            ) {
              settle()
            }
            return
          }
          for (const row of hint.rows ?? []) {
            if (
              row.kind !== 'dispatch' ||
              row.state !== 'pending' ||
              row.epoch !== hint.journal.physicalCursor().epoch ||
              row.clientMessageId !== clientMessageId
            ) {
              continue
            }
            const record = store.getRecord(sessionId)
            const owner =
              record && record.lease.runtimeFence === row.fence
                ? input.host.deps.adapter.captureConversationTitleOwner?.(record)
                : null
            settle(owner && record && owner.isCurrent(record) ? owner : null)
            return
          }
        },
        error: () => settle()
      })
    )
  } catch {
    settle()
  }
  return pending
}
