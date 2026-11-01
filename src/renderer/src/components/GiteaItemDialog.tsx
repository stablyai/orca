import { useCallback, useMemo } from 'react'
import { ForgeItemDialog } from './gitlab-item-dialog/forge-item-dialog'
import { createGiteaDialogForge } from './gitea-item-dialog/gitea-dialog-forge'
import { giteaItemToDialogItem } from './gitea-item-dialog/gitea-dialog-mappers'
import type { GiteaWorkItem } from '../../../shared/gitea-types'
import type { TaskSourceContext } from '../../../shared/task-source-context'

export type GiteaItemDialogProps = {
  item: GiteaWorkItem | null
  repoPath: string | null
  repoId?: string | null
  sourceContext?: TaskSourceContext | null
  onClose: () => void
  onCreateWorkspace?: (item: GiteaWorkItem) => void
}

export default function GiteaItemDialog({
  item,
  repoPath,
  repoId,
  sourceContext,
  onClose,
  onCreateWorkspace
}: GiteaItemDialogProps) {
  const forge = useMemo(() => createGiteaDialogForge(), [])
  const dialogItem = useMemo(() => (item ? giteaItemToDialogItem(item) : null), [item])
  const handleCreateWorkspace = useCallback((): void => {
    if (item) {
      onCreateWorkspace?.(item)
    }
  }, [item, onCreateWorkspace])
  return (
    <ForgeItemDialog
      forge={forge}
      item={dialogItem}
      repoPath={repoPath}
      repoId={repoId}
      sourceContext={sourceContext}
      onClose={onClose}
      onCreateWorkspace={onCreateWorkspace ? handleCreateWorkspace : undefined}
    />
  )
}
