// Saving a thread's mute: written to its link, then flushed to disk. A flush that fails puts the
// previous value back, so a mute in memory is only ever one on disk or still being saved, and the
// delivery that asked for it is refused and sent again.
import { writeLinkFact } from '../external-conversations/external-conversation-link-writes'
import type { ExternalConversationLinkStore } from '../external-conversations/external-conversation-links'
import type { ConnectorConversation } from '../../shared/connectors/connector-cloud-contract'
import type { RuntimeStore } from '../runtime/construction/runtime-store-contract'

type MuteSaveStore = ExternalConversationLinkStore & Pick<RuntimeStore, 'flushPendingOrThrowAsync'>

/** The mute's write: settles once on disk, and rejects with the previous value kept when not. */
export function threadMuteSaves(
  store: MuteSaveStore
): (key: ConnectorConversation, muted: boolean) => Promise<void> {
  return async (key, muted) => {
    // Already so: a resend after a crash past its save, or a mute repeated, has nothing to save.
    if (!writeLinkFact(store, key, { muted: muted ? true : undefined })) {
      return
    }
    try {
      await store.flushPendingOrThrowAsync?.({ drainToStableGeneration: false })
    } catch (error) {
      writeLinkFact(store, key, { muted: muted ? undefined : true })
      throw error
    }
  }
}
