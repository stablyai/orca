import { useEffect } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { ProfileStateSaveNotice } from '../../../../shared/orca-profiles/profile-state-save-notice'

export function useProfileStateSaveDelayNotice(): void {
  useEffect(() => {
    const app = window.api?.app
    if (!app?.onProfileStateSaveDelayChanged || !app.isProfileStateSaveDelayed) {
      return
    }
    let disposed = false
    let receivedChange = false
    // Deferred dismissal must target this warning, never its replacement.
    let toastId: ReturnType<typeof toast.warning> | undefined
    const dismissNotice = (): void => {
      if (toastId !== undefined) {
        toast.dismiss(toastId)
        toastId = undefined
      }
    }
    const present = (notice: ProfileStateSaveNotice): void => {
      if (disposed) {
        return
      }
      if (notice === null) {
        dismissNotice()
        return
      }
      const { title, description } = saveNoticeText(notice)
      // Reusing the id updates the open warning in place when its reason changes.
      toastId = toast.warning(title, { id: toastId, description, duration: Infinity })
    }
    const unsubscribe = app.onProfileStateSaveDelayChanged((notice) => {
      receivedChange = true
      present(notice)
    })
    void app
      .isProfileStateSaveDelayed()
      .then((notice) => {
        // A pushed change is newer than the initial snapshot read.
        if (!receivedChange) {
          present(notice)
        }
      })
      .catch((error: unknown) => console.warn('[persistence] Could not read saving status:', error))
    return () => {
      disposed = true
      unsubscribe()
      dismissNotice()
    }
  }, [])
}

function saveNoticeText(notice: Exclude<ProfileStateSaveNotice, null>): {
  title: string
  description: string
} {
  if (notice === 'slow') {
    return {
      title: translate('app.saving.slowTitle', 'Saving is taking longer than usual'),
      description: translate(
        'app.saving.slowDescription',
        'Orca is still saving your recent changes.'
      )
    }
  }
  if (notice === 'disk-full') {
    return {
      title: translate('app.saving.diskFullTitle', 'Your disk is full'),
      description: translate(
        'app.saving.diskFullDescription',
        "Orca can't save your changes. Recent changes to settings, projects, workspaces, open tabs, bots, and automations could be lost if you quit. Free up some disk space."
      )
    }
  }
  return {
    title: translate('app.saving.unsavedTitle', 'Orca is currently unable to save your changes'),
    description: translate(
      'app.saving.unsavedDescription',
      'Recent changes to settings, projects, workspaces, open tabs, bots, and automations could be lost if you quit.'
    )
  }
}
