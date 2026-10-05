import { useEffect } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '../store'
import { createEditorRecoverySubscriber } from '../lib/editor-recovery-subscriber'
import { flushPendingEditorChange } from '../components/editor/editor-pending-flush'
import {
  OPEN_EDITOR_RECOVERY_EVENT,
  openEditorRecovery,
  getEditorRecoveryCheckpoint
} from '../lib/editor-recovery-checkpoints'
import { shouldPersistWorkspaceSession } from '../lib/workspace-session'
import { getExternalRecoveryBuffers } from '../lib/editor-recovery-external-buffers'
import { translate } from '../i18n/i18n'

export function useAppEditorRecovery(): void {
  useEffect(() => {
    const open = (): void => useAppStore.getState().openModal('editor-recovery')
    window.addEventListener(OPEN_EDITOR_RECOVERY_EVENT, open)
    return () => window.removeEventListener(OPEN_EDITOR_RECOVERY_EVENT, open)
  }, [])

  useEffect(() => {
    const api = window.api.session.recovery
    if (!api) {
      return
    }
    let failed = false
    const subscriber = createEditorRecoverySubscriber({
      store: useAppStore,
      api,
      flushPendingChanges: flushPendingEditorChange,
      onPersisted: () => {
        if (failed) {
          failed = false
          toast.dismiss('editor-recovery-failed')
        }
      },
      onError: (error) => {
        console.error('[editor-recovery] Draft checkpoint failed:', error)
        if (failed) {
          return
        }
        failed = true
        toast.error(
          translate('editorRecovery.checkpointFailed', 'Unsaved changes could not be backed up.'),
          {
            id: 'editor-recovery-failed',
            duration: Infinity,
            action: {
              label: translate('editorRecovery.retry', 'Retry'),
              onClick: () => {
                void subscriber
                  .flush()
                  .then(() => {
                    failed = false
                    toast.dismiss('editor-recovery-failed')
                  })
                  .catch(console.error)
              }
            }
          }
        )
      }
    })
    let checked = false
    let disposed = false
    const checkOrphans = (): void => {
      if (checked || !shouldPersistWorkspaceSession(useAppStore.getState())) {
        return
      }
      checked = true
      void api
        .list()
        .then((entries) => {
          if (disposed) {
            return
          }
          const activeIds = new Set(
            [
              ...useAppStore.getState().openFiles,
              ...getExternalRecoveryBuffers().map((buffer) => buffer.file)
            ].flatMap((file) =>
              file.isDirty ? [getEditorRecoveryCheckpoint(file.id)?.id ?? file.recoveryId] : []
            )
          )
          const count = entries.filter((entry) => !activeIds.has(entry.id)).length
          if (count > 0) {
            toast.info(
              translate('editorRecovery.available', 'Unsaved drafts are available to recover.'),
              {
                id: 'editor-recovery-available',
                duration: 15_000,
                action: {
                  label: translate('editorRecovery.review', 'Review'),
                  onClick: openEditorRecovery
                }
              }
            )
          }
        })
        .catch((error) => console.error('[editor-recovery] Could not list drafts:', error))
    }
    checkOrphans()
    const unsubscribe = useAppStore.subscribe(checkOrphans)
    return () => {
      disposed = true
      unsubscribe()
      subscriber.dispose()
    }
  }, [])
}
