// Saving a thread's mute: written to its link, then flushed to disk. A flush that fails puts the
// previous value back, so a mute in memory is only ever one on disk or still being saved, and the
// delivery or leave that asked for it is refused. While one saves, the thread's replies wait for it.
import {
  readThreadMute,
  writeLinkFact
} from '../external-conversations/external-conversation-link-writes'
import type { ExternalConversationLinkStore } from '../external-conversations/external-conversation-links'
import type { ConnectorConversation } from '../../shared/connectors/connector-cloud-contract'
import type { RuntimeStore } from '../runtime/construction/runtime-store-contract'

type MuteSaveStore = ExternalConversationLinkStore & Pick<RuntimeStore, 'flushPendingOrThrowAsync'>

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
    // Already so: a resend after a crash past its save, or a mute repeated, has nothing to save.
    if (!writeLinkFact(store, key, { muted: muted ? true : undefined, leaveLine })) {
      return
    }
    const id = idOf(key)
    const flushed = store.flushPendingOrThrowAsync?.({ drainToStableGeneration: false })
    const settled = Promise.resolve(flushed).catch(() => undefined)
    saving.set(id, settled)
    try {
      await flushed
    } catch (error) {
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
