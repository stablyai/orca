import { ipcMain } from 'electron'
import type { Store } from '../persistence'
import type { PersistedUIState } from '../../shared/persisted-ui-state-types'
import {
  isPetAgentAnimation,
  isPetWindowPosition,
  type PetAgentAnimation
} from '../../shared/pet-types'
import {
  closeDesktopPetWindow,
  createOrRevealDesktopPetWindow,
  getDesktopPetWindow,
  isDesktopPetRenderer,
  moveDesktopPetWindow,
  setDesktopPetInteractive
} from '../window/desktop-pet-window'
import { isTrustedUIRenderer, sendToTrustedUIRenderer } from './ui'

// The last animation the main renderer published, replayed the instant the pet window mounts so
// it doesn't idle through the first agent tick. Cleared on close so a re-detach never resumes a
// stale state.
let lastAnimation: PetAgentAnimation | null = null

/** The pet is detached only when the experimental flag is on, the pet is not hidden, and the
 *  user asked for it to live on the desktop. */
export function shouldShowDesktopPetWindow(
  ui: Pick<PersistedUIState, 'petDetached' | 'petVisible'>,
  petExperimentEnabled: boolean
): boolean {
  return petExperimentEnabled && ui.petDetached === true && ui.petVisible !== false
}

export function registerDesktopPetHandlers(store: Store): void {
  ipcMain.removeHandler('desktopPet:publishAnimation')
  ipcMain.removeHandler('desktopPet:requestAnimation')
  ipcMain.removeHandler('desktopPet:move')
  ipcMain.removeHandler('desktopPet:setInteractive')

  const reconcile = (): void => {
    const shouldShow = shouldShowDesktopPetWindow(
      store.getUI(),
      store.getSettings().experimentalPet === true
    )
    if (shouldShow) {
      createOrRevealDesktopPetWindow(store)
      return
    }
    lastAnimation = null
    closeDesktopPetWindow()
  }

  store.onUIChanged(reconcile)
  store.onSettingsChanged((updates) => {
    if ('experimentalPet' in updates) {
      reconcile()
    }
  })

  // Relay: only the main renderer knows the agent store, so it derives the animation and the
  // pet window is a pure consumer.
  ipcMain.handle('desktopPet:publishAnimation', (event, animation: unknown): void => {
    if (!isTrustedUIRenderer(event.sender) || !isPetAgentAnimation(animation)) {
      return
    }
    lastAnimation = animation
    getDesktopPetWindow()?.webContents.send('desktopPet:animation', animation)
  })

  // The pet window asks on mount: replay the cache, then nudge the main renderer to republish.
  ipcMain.handle('desktopPet:requestAnimation', (event): void => {
    if (!isDesktopPetRenderer(event.sender)) {
      return
    }
    if (lastAnimation) {
      event.sender.send('desktopPet:animation', lastAnimation)
    }
    sendToTrustedUIRenderer('desktopPet:animationRequested', null)
  })

  ipcMain.handle('desktopPet:move', (event, position: unknown): void => {
    if (!isDesktopPetRenderer(event.sender) || !isPetWindowPosition(position)) {
      return
    }
    moveDesktopPetWindow(store, position)
  })

  ipcMain.handle('desktopPet:setInteractive', (event, interactive: unknown): void => {
    if (!isDesktopPetRenderer(event.sender) || typeof interactive !== 'boolean') {
      return
    }
    setDesktopPetInteractive(interactive)
  })

  reconcile()
}
