import type { GlobalSettings } from '../../shared/settings/global-settings-types'
import type { KeybindingFileSnapshot } from '../../shared/keybindings/types'
import { areFloatingWorkspaceShortcutsActive } from '../../shared/settings/floating-workspace-cohort'
import type { KeybindingService } from './keybinding-service'

type FloatingWorkspaceKeybindingSyncArgs = {
  store: {
    onSettingsChanged(
      listener: (updates: Partial<GlobalSettings>, settings: GlobalSettings) => void
    ): () => void
  }
  keybindings: Pick<
    KeybindingService,
    | 'reload'
    | 'publishInactiveFloatingWorkspaceFallback'
    | 'committedFloatingWorkspaceShortcutsActive'
  >
  broadcast?: (snapshot: KeybindingFileSnapshot) => void
  onChanged?: () => Promise<void> | void
}

function logFailure(step: string, error: unknown): void {
  console.error(`[keybindings] Floating workspace change: ${step} failed:`, error)
}

/** Republishes keybindings when the floating predicate flips, so no reader pairs it with a stale map. */
export function installFloatingWorkspaceKeybindingSync({
  store,
  keybindings,
  broadcast = (snapshot) => {
    void import('./keybindings-broadcast')
      .then(({ broadcastKeybindingsChanged }) => broadcastKeybindingsChanged(snapshot))
      .catch((error: unknown) => logFailure('broadcast', error))
  },
  onChanged
}: FloatingWorkspaceKeybindingSyncArgs): () => void {
  return store.onSettingsChanged((updates, settings) => {
    if (!('floatingTerminalEnabled' in updates)) {
      return
    }
    // Compare with what is published, not a private flag, so a failed reload retries next time.
    if (
      areFloatingWorkspaceShortcutsActive(settings) ===
      keybindings.committedFloatingWorkspaceShortcutsActive()
    ) {
      return
    }
    let snapshot: KeybindingFileSnapshot
    try {
      // Synchronous, so main's next keydown already matches against the republished snapshot.
      snapshot = keybindings.reload()
    } catch (error) {
      logFailure('reload', error)
      snapshot = keybindings.publishInactiveFloatingWorkspaceFallback()
    }
    try {
      broadcast(snapshot)
    } catch (error) {
      logFailure('broadcast', error)
    }
    try {
      void Promise.resolve(onChanged?.()).catch((error: unknown) =>
        logFailure('plugin reconcile', error)
      )
    } catch (error) {
      logFailure('plugin reconcile', error)
    }
  })
}
