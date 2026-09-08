import React, { useCallback } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'

const RemoveFolderDialog = React.memo(function RemoveFolderDialog() {
  const activeModal = useAppStore((s) => s.activeModal)
  const modalData = useAppStore((s) => s.modalData)
  const closeModal = useAppStore((s) => s.closeModal)
  const removeProject = useAppStore((s) => s.removeProject)

  const isOpen = activeModal === 'confirm-remove-folder'
  const repoId = typeof modalData.repoId === 'string' ? modalData.repoId : ''
  const displayName = typeof modalData.displayName === 'string' ? modalData.displayName : ''

  // Why: for an SSH project the files live on the remote host's disk, not the
  // user's — "still on your disk" would be misleading. Name the host (using the
  // removed-target label when it's a ghost) so the user knows where it remains
  // and that re-adding that host recovers it.
  const sshHostLabel = useAppStore((s) => {
    const connectionId = s.repos.find((r) => r.id === repoId)?.connectionId?.trim()
    if (!connectionId) {
      return null
    }
    return (
      s.sshTargetLabels.get(connectionId) ??
      s.removedSshTargetLabels.get(connectionId) ??
      connectionId
    )
  })

  const handleConfirm = useCallback(() => {
    if (repoId) {
      void removeProject(repoId)
    }
    closeModal()
  }, [closeModal, removeProject, repoId])

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        closeModal()
      }
    },
    [closeModal]
  )

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-sm sm:max-w-sm" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="text-sm">
            {translate('auto.components.sidebar.RemoveFolderDialog.b79b39d865', 'Remove Project')}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {translate(
              'auto.components.sidebar.RemoveFolderDialog.e62415c3d0',
              'This only removes'
            )}{' '}
            <span className="break-all font-medium text-foreground">{displayName}</span>{' '}
            {sshHostLabel
              ? translate(
                  'auto.components.sidebar.RemoveFolderDialog.fromOrcaSsh',
                  'from Orca. Its files stay on {{value0}} — re-add that SSH host to recover it.',
                  { value0: sshHostLabel }
                )
              : translate(
                  'auto.components.sidebar.RemoveFolderDialog.8c097ef04e',
                  'from Orca. It is still on your disk.'
                )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            {translate('auto.components.sidebar.RemoveFolderDialog.d36883e046', 'Cancel')}
          </Button>
          <Button variant="destructive" onClick={handleConfirm}>
            {translate('auto.components.sidebar.RemoveFolderDialog.4dc5b5065b', 'Remove')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
})

export default RemoveFolderDialog
