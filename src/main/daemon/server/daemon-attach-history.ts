import type { TerminalHost } from '../terminal-host/terminal-host'
import type {
  AttachHistoryAdmission,
  CreateOrAttachResult
} from '../terminal-host/terminal-host-create-contract'
import type { HistoryFlight } from '../history/journal/terminal-history-read-admission'
import type { HistoryReadConsumer } from '../history/journal/terminal-history-read-consumer'
import { TerminalAttachCanceledError } from '../protocol/daemon-errors'
import { TerminalHistoryUnavailableError } from '../protocol/daemon-history-protocol'
import {
  ABANDONED_REPLY,
  withPreparedReply,
  type PreparedDaemonReply
} from './daemon-reply-obligation'

// Bounded like the former adapter overlay; the live terminal keeps running meanwhile.
const ATTACH_HISTORY_IMAGE_DEADLINE_MS = 5_000

/** The complete reply line for an attach result, from the existing encoder and projection. */
export type EncodeAttachReply = (result: Omit<CreateOrAttachResult, 'attachToken'>) => string

/**
 * An attach's deep-history read. A cached or joined image is awaited with the old viewer still
 * attached and its full reply is encoded in the same turn as the token install, at a proved
 * anchor. A cold leader installs its token at C, reconstructs, then encodes before the final
 * membership check. Every exit releases the consumer once, through the reply that carries it.
 */
export function openAttachHistory(
  host: TerminalHost,
  request: { cancelSignal: AbortSignal; isCanceled: () => boolean },
  encodeReply: EncodeAttachReply
): {
  admission: AttachHistoryAdmission
  finish(
    sessionId: string,
    result: CreateOrAttachResult
  ): Promise<{ result: CreateOrAttachResult; prepared?: PreparedDaemonReply }>
  fail(error: unknown): unknown
} {
  const journals = host.historyJournals!
  let consumer: HistoryReadConsumer | null = null
  let leading: HistoryFlight | null = null
  let line: string | undefined
  let encodedClaim: CreateOrAttachResult['agentSessionEnsure']
  // One absolute deadline for every admission, join, retry and settlement of this attach.
  let deadline: AbortSignal | null = null
  let signal: AbortSignal | null = null
  const owned = (): PreparedDaemonReply | null => {
    const held = consumer
    return held ? { ...(line ? { line } : {}), release: () => held.release() } : null
  }
  const admission: AttachHistoryAdmission = {
    admit: async (sessionId, incarnationId) => {
      const journal = journals.live(sessionId, incarnationId)
      const session = journal?.session
      if (!journal || !session || journal.gapped) {
        return null
      }
      deadline ??= AbortSignal.timeout(ATTACH_HISTORY_IMAGE_DEADLINE_MS)
      signal ??= AbortSignal.any([request.cancelSignal, deadline])
      consumer ??= journals.reads.admit(signal)
      const reader = consumer
      if (!reader) {
        throw withPreparedReply(new TerminalHistoryUnavailableError(), ABANDONED_REPLY)
      }
      reader.dropImage()
      line = undefined
      const found = await reader.acquire(journal, undefined, () =>
        session.settleShellOwnershipConfirmation()
      )
      if (!found) {
        throw new TerminalHistoryUnavailableError()
      }
      leading = found === 'image' ? null : found
      return {
        capture: (result) => {
          if (leading) {
            // The cold leader's provisional token goes in at C; refusal leaves the old viewer.
            if (!leading.capture()) {
              throw new TerminalHistoryUnavailableError()
            }
            return 'captured'
          }
          // The live snapshot already ran its barrier; the image must match this exact anchor.
          const image = reader.image
          if (!image || journal.derivedKey(undefined) !== reader.key) {
            return 'retry'
          }
          result.snapshot = image.snapshot
          result.history = image.outcome
          // Owned once: a later launch-note change cannot alter the encoded reply.
          result.launchNote = structuredClone(result.launchNote)
          line = encodeOrUnavailable(encodeReply, result)
          encodedClaim = result.agentSessionEnsure
          return 'captured'
        },
        release: () => {
          leading = null
          reader.dropImage()
        }
      }
    }
  }
  // This attach's own history deadline leaves the healthy terminal in place: the same ID retries.
  const ownDeadline = (error: unknown): boolean =>
    deadline !== null &&
    deadline.aborted &&
    error === deadline.reason &&
    !request.cancelSignal.aborted
  const fail = (error: unknown): unknown => {
    const reply = owned()
    consumer = null
    const failure =
      error instanceof Error && !ownDeadline(error) ? error : new TerminalHistoryUnavailableError()
    return reply ? withPreparedReply(failure, { release: reply.release }) : failure
  }
  const finish = async (
    sessionId: string,
    result: CreateOrAttachResult
  ): Promise<{ result: CreateOrAttachResult; prepared?: PreparedDaemonReply }> => {
    const journal = journals.live(sessionId, result.incarnationId)
    if (result.isNew || !consumer) {
      consumer?.release()
      consumer = null
      // A permanent gap still attaches the same live window, explicitly labelled.
      const unavailable = { kind: 'unavailable' as const, incarnationId: result.incarnationId }
      const outputSequence = result.isNew ? 0 : (result.snapshot?.outputSequence ?? 0)
      return { result: { ...result, history: journal?.outcome(outputSequence) ?? unavailable } }
    }
    const reader = consumer
    try {
      let final = result
      if (leading) {
        const built = await reader.awaitFlight(leading)
        if (request.isCanceled()) {
          throw new TerminalAttachCanceledError(sessionId)
        }
        const image = reader.image
        if (!built || !image || !journal) {
          // Transient: the live owner is known, so the same ID retries; never presumed gone.
          throw new TerminalHistoryUnavailableError()
        }
        final = { ...result, snapshot: image.snapshot, history: image.outcome }
        line = encodeOrUnavailable(encodeReply, final)
      } else if (final.agentSessionEnsure !== encodedClaim) {
        // A claim settled only after its inner attach: the line must report what the caller does.
        line = encodeOrUnavailable(encodeReply, final)
      }
      // Final membership check, with no await before the caller commits the attachment.
      if (
        journals.live(sessionId, result.incarnationId) !== journal ||
        !journal?.hasAttachedClient(result.attachToken)
      ) {
        throw new TerminalAttachCanceledError(sessionId)
      }
      return { result: final, prepared: owned()! }
    } catch (error) {
      host.detach(sessionId, result.attachToken)
      throw fail(error)
    }
  }
  return { admission, finish, fail }
}

/** An over-long reply is honestly unavailable, never a smaller image; the existing encoder decides. */
function encodeOrUnavailable(
  encodeReply: EncodeAttachReply,
  result: Omit<CreateOrAttachResult, 'attachToken'>
): string {
  try {
    return encodeReply(result)
  } catch {
    throw new TerminalHistoryUnavailableError()
  }
}
