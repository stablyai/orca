// Saving a thread's mute: written to its link at once, then flushed to disk. A failed flush is
// tried again on its own, backing off, until one lands, so an unmute a mention answered through
// a failing disk is still kept.
import { writeLinkFact } from '../external-conversations/external-conversation-link-writes'
import type { ExternalConversationLinkStore } from '../external-conversations/external-conversation-links'
import type { ConnectorConversation } from '../../shared/connectors/connector-cloud-contract'
import type { RuntimeStore } from '../runtime/construction/runtime-store-contract'

const FIRST_RETRY_MS = 5_000
const MAX_RETRY_MS = 300_000

type MuteSaveStore = ExternalConversationLinkStore & Pick<RuntimeStore, 'flushPendingOrThrowAsync'>

/** The mute's write: settles once on disk, and rejects (retrying in the background) when not. */
export function threadMuteSaves(
  store: MuteSaveStore
): (key: ConnectorConversation, muted: boolean) => Promise<void> {
  // Threads whose mute is in memory but not yet on disk: its save failed, or is still running.
  const unsaved = new Set<string>()
  let retry: ReturnType<typeof setTimeout> | null = null
  let delay = FIRST_RETRY_MS
  const flush = async (): Promise<void> => {
    // A flush saves every change made before it began: those threads' mutes are then on disk.
    const covered = [...unsaved]
    await store.flushPendingOrThrowAsync?.({ drainToStableGeneration: false })
    for (const id of covered) {
      unsaved.delete(id)
    }
    delay = FIRST_RETRY_MS
  }
  const retryLater = (): void => {
    if (retry) {
      return
    }
    retry = setTimeout(() => {
      retry = null
      flush().catch((error: unknown) => {
        console.warn('[connectors] could not save a thread mute; trying again', error)
        delay = Math.min(delay * 2, MAX_RETRY_MS)
        retryLater()
      })
    }, delay)
    retry.unref?.()
  }
  return async (key, muted) => {
    const id = JSON.stringify([key.source, key.externalId])
    // Already so and on disk: nothing to do. Already so but not yet on disk (another reply's save
    // still running, or failed): this one waits for a save of its own.
    if (!writeLinkFact(store, key, { muted: muted ? true : undefined }) && !unsaved.has(id)) {
      return
    }
    unsaved.add(id)
    try {
      await flush()
    } catch (error) {
      retryLater()
      throw error
    }
  }
}
