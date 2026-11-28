import { sendToTrustedUIRenderer } from '../../ipc/ui'
import type { ProfileStateSaveNotice } from '../../../shared/orca-profiles/profile-state-save-notice'

let saveNotice: ProfileStateSaveNotice = null

export function isProfileStateSaveDelayed(): ProfileStateSaveNotice {
  return saveNotice
}

export function reportProfileStateSaveDelay(notice: ProfileStateSaveNotice): void {
  if (saveNotice === notice) {
    return
  }
  saveNotice = notice
  try {
    sendToTrustedUIRenderer('app:profileStateSaveDelayChanged', notice)
  } catch (error) {
    // The snapshot remains available when the renderer reopens.
    console.warn('[persistence] Could not publish delayed saving:', error)
  }
}
