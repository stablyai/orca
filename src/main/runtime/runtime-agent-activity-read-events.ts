import { isDeepStrictEqual } from 'node:util'
import type { RuntimeStore } from './construction/runtime-store-contract'
import type { RuntimeClientEvent } from '../../shared/runtime-client-events'

export function publishAgentActivityReadChanges(
  store: Pick<RuntimeStore, 'getUI' | 'onUIChanged'> | null,
  emit: (event: RuntimeClientEvent) => void
): void {
  if (!store?.getUI || !store.onUIChanged) {
    return
  }
  const initial = store.getUI()
  let previous = [initial.acknowledgedAgentsByPaneKey, initial.manuallyUnreadTurnsByPaneKey]
  store.onUIChanged((ui) => {
    const next = [ui.acknowledgedAgentsByPaneKey, ui.manuallyUnreadTurnsByPaneKey]
    if (!isDeepStrictEqual(previous, next)) {
      previous = next
      emit({ type: 'agentActivityReadStateChanged' })
    }
  })
}
