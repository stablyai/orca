// Saving a thread's mute: written to its link, then flushed to disk. A flush that fails puts the
// previous value back, so a mute in memory is only ever one on disk or still being saved, and the
// delivery or leave that asked for it is refused (unless the write's outcome is unknown). While one saves, the thread's replies wait for it.
import {
  readThreadMute,
  writeLinkFact
} from '../external-conversations/external-conversation-link-writes'
import type { ExternalConversationLinkStore } from '../external-conversations/external-conversation-links'
import type { ConnectorConversation } from '../../shared/connectors/connector-cloud-contract'
import type { RuntimeStore } from '../runtime/construction/runtime-store-contract'
import { profileStateWriterFailureOutcome } from '../persistence/profile-state/writer/profile-state-writer-errors'

type MuteSaveStore = ExternalConversationLinkStore & Pick<RuntimeStore, 'flushPendingOrThrowAsync'>

/** A save whose write may or may not have reached disk: the new value is kept, as disk may hold
 *  it, and the next save writes it again. */
export class ThreadMuteUnconfirmedError extends Error {
  constructor(cause: unknown) {
    super("the thread's mute may not be on disk", { cause })
    this.name = 'ThreadMuteUnconfirmedError'
  }
}

const saving = new Map<string, Promise<unknown>>()
const idOf = (key: ConnectorConversation) => JSON.stringify([key.source, key.externalId])

/** The thread's mute still on its way to disk, if one is: a reply waits for it, so none is silenced
 *  by a mute that then fails to save. */
export function threadMuteSaving(key: ConnectorConversation): Promise<unknown> | undefined {
  return saving.get(idOf(key)) ?? reserved.get(idOf(key))
}

const reserved = new Map<string, Promise<unknown>>()

/** A save that will run once its turn in the thread's queue comes (a leave waiting there): replies
 *  from now on wait for it too. Call the returned release once it settled or was refused. */
export function reserveThreadMuteSave(key: ConnectorConversation): () => void {
  const id = idOf(key)
  let release = (): void => {}
  const settled = new Promise<void>((resolve) => (release = resolve))
  reserved.set(id, settled)
  return () => {
    release()
    if (reserved.get(id) === settled) {
      reserved.delete(id)
    }
  }
}

/** The mute's write: settles once on disk, and rejects with the previous value kept when not.
 *  `leaveLine`: a leave's turn, whose confirmation Orca then owes; an unmute drops any owed. */
export function threadMuteSaves(
  store: MuteSaveStore
): (key: ConnectorConversation, muted: boolean, leaveLine?: number) => Promise<void> {
  return async (key, muted, leaveLine) => {
    const before = readThreadMute(store, key)
    const previous = typeof before === 'object' && before !== null ? before : null
    // Already so (a resend after a crash past its save, a mute repeated, or one an unknown save left
    // in memory): nothing new to write, but it is answered only once a flush says it is on disk.
    if (!writeLinkFact(store, key, { muted: muted ? true : undefined, leaveLine })) {
      try {
        await store.flushPendingOrThrowAsync?.({ drainToStableGeneration: false })
      } catch (error) {
        throw new ThreadMuteUnconfirmedError(error)
      }
      return
    }
    const id = idOf(key)
    const flushed = store.flushPendingOrThrowAsync?.({ drainToStableGeneration: false })
    const settled = Promise.resolve(flushed).catch(() => undefined)
    saving.set(id, settled)
    try {
      await flushed
    } catch (error) {
      if (profileStateWriterFailureOutcome(error) === 'indeterminate') {
        throw new ThreadMuteUnconfirmedError(error)
      }
      writeLinkFact(store, key, {
        muted: previous?.muted ? true : undefined,
        leaveLine: previous?.leaveLine
      })
      throw error
    } finally {
      if (saving.get(id) === settled) {
        saving.delete(id)
      }
    }
  }
}
