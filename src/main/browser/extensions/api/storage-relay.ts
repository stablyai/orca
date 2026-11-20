import { z } from 'zod'
import { emitBrowserExtensionEvent } from '../api-runtime/browser-extension-api-host'
import { noteBrowserExtensionNeedsCleanStart } from '../profile-sessions/browser-extension-idle-kept-state'
import {
  defineBrowserExtensionMethod,
  registerBrowserExtensionNamespace
} from '../api-runtime/browser-extension-namespace-registry'

/**
 * Electron never fires chrome.storage.onChanged in extension service workers, so extension pages
 * report their own storage writes here and main forwards them to the same extension's worker in the
 * same session (see src/preload/browser/extensions/storage/browser-extension-storage-relay.ts). Workers deliver their own.
 * Sync is not relayed: main owns that area and fires its events (api/storage-sync.ts).
 */
const STORAGE_RELAY_NAMESPACE = 'orcaStorageRelay'

const changesSchema = z.record(
  z.string(),
  z.object({ oldValue: z.unknown().optional(), newValue: z.unknown().optional() }).strict()
)

export function registerStorageRelayNamespace(): void {
  // Preload-only: never on the API surface, so extension code does not see it.
  registerBrowserExtensionNamespace(STORAGE_RELAY_NAMESPACE, {
    methods: {
      report: defineBrowserExtensionMethod(
        z.tuple([z.enum(['local', 'session']), changesSchema]),
        (caller, areaName, changes) => {
          if (areaName === 'session') {
            noteBrowserExtensionNeedsCleanStart(caller.browserProfileId, caller.extension.id)
          }
          // Why only noted: a worker delivers its own changes; it reports only its first session use.
          if (caller.fromWorker || Object.keys(changes).length === 0) {
            return
          }
          emitBrowserExtensionEvent(
            { session: caller.session, extensionId: caller.extension.id },
            STORAGE_RELAY_NAMESPACE,
            'onChanged',
            [changes, areaName]
          )
        }
      )
    },
    events: ['onChanged']
  })
}
