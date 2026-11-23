import { useEffect } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

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
    const present = (delayed: boolean): void => {
      if (disposed) {
        return
      }
      if (!delayed) {
        dismissNotice()
        return
      }
      toastId = toast.warning(
        translate('app.saving.unsavedTitle', 'Orca is currently unable to save your changes'),
        {
          id: toastId,
          description: translate(
            'app.saving.unsavedDescription',
            'Recent changes to settings, projects, workspaces, open tabs, bots, and automations could be lost if you quit. If your disk is full, free up some space.'
          ),
          duration: Infinity
        }
      )
    }
    const unsubscribe = app.onProfileStateSaveDelayChanged((delayed) => {
      receivedChange = true
      present(delayed)
    })
    void app
      .isProfileStateSaveDelayed()
      .then((delayed) => {
        // A pushed change is newer than the initial snapshot read.
        if (!receivedChange) {
          present(delayed)
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
