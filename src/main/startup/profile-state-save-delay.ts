import { sendToTrustedUIRenderer } from '../ipc/ui'

let saveDelayed = false

export function isProfileStateSaveDelayed(): boolean {
  return saveDelayed
}

export function reportProfileStateSaveDelay(delayed: boolean): void {
  if (saveDelayed === delayed) {
    return
  }
  saveDelayed = delayed
  try {
    sendToTrustedUIRenderer('app:profileStateSaveDelayChanged', delayed)
  } catch (error) {
    // The snapshot remains available when the renderer reopens.
    console.warn('[persistence] Could not publish delayed saving:', error)
  }
}
