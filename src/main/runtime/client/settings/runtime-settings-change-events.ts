import { isDeepStrictEqual } from 'node:util'
import type { RuntimeClientEvent } from '../../../../shared/runtime-client-events'
import type { RuntimeStore } from '../../construction/runtime-store-contract'

/** Tells clients which top-level settings changed, so a phone re-reads only what it shows. */
export function publishSettingsChanges(
  store: Pick<RuntimeStore, 'getSettings' | 'onSettingsChanged'> | null,
  emit: (event: RuntimeClientEvent) => void
): void {
  if (!store?.getSettings || !store.onSettingsChanged) {
    return
  }
  let previous = new Map<string, unknown>(Object.entries(store.getSettings()))
  store.onSettingsChanged((updates, settings) => {
    const next = new Map<string, unknown>(Object.entries(settings))
    // A writer may resend a value it did not change, as an equal but new object.
    const keys = Object.keys(updates).filter(
      (key) => !isDeepStrictEqual(previous.get(key), next.get(key))
    )
    previous = next
    if (keys.length > 0) {
      emit({ type: 'settingsChanged', keys })
    }
  })
}
