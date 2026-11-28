import type { GlobalSettings } from '../../shared/settings/global-settings-types'
import type { KeybindingFileSnapshot } from '../../shared/keybindings/types'
import { areFloatingWorkspaceShortcutsActive } from '../../shared/settings/floating-workspace-cohort'
import type { KeybindingService } from './keybinding-service'

type FloatingWorkspaceKeybindingSyncArgs = {
  store: {
    getSettings(): Readonly<GlobalSettings>
    onSettingsChanged(
      listener: (updates: Partial<GlobalSettings>, settings: GlobalSettings) => void
    ): () => void
  }
  keybindings: Pick<KeybindingService, 'reload' | 'publishInactiveFloatingWorkspaceFallback'>
  broadcast?: (snapshot: KeybindingFileSnapshot) => void
  onChanged?: () => Promise<void> | void
}

/** Republishes keybindings when the floating predicate flips, so no reader pairs it with a stale map. */
export function installFloatingWorkspaceKeybindingSync({
  store,
  keybindings,
  broadcast = (snapshot) => {
    void import('./keybindings-broadcast')
      .then(({ broadcastKeybindingsChanged }) => broadcastKeybindingsChanged(snapshot))
      .catch((error: unknown) => {
        console.error('[keybindings] Failed to broadcast the floating workspace change:', error)
      })
  },
  onChanged
}: FloatingWorkspaceKeybindingSyncArgs): () => void {
  let active = areFloatingWorkspaceShortcutsActive(store.getSettings())
  return store.onSettingsChanged((updates, settings) => {
    if (!('floatingTerminalEnabled' in updates)) {
      return
    }
    const next = areFloatingWorkspaceShortcutsActive(settings)
    if (next === active) {
      return
    }
    active = next
    let snapshot: KeybindingFileSnapshot
    try {
      // Synchronous, so main's next keydown already sees the republished map.
      snapshot = keybindings.reload()
    } catch (error) {
      console.error('[keybindings] Failed to reload for the floating workspace change:', error)
      snapshot = keybindings.publishInactiveFloatingWorkspaceFallback()
    }
    try {
      broadcast(snapshot)
    } catch (error) {
      console.error('[keybindings] Failed to broadcast the floating workspace change:', error)
    }
    try {
      void Promise.resolve(onChanged?.()).catch((error: unknown) => {
        console.error(
          '[keybindings] Plugin reconcile after the floating workspace change failed:',
          error
        )
      })
    } catch (error) {
      console.error(
        '[keybindings] Plugin reconcile after the floating workspace change failed:',
        error
      )
    }
  })
}
