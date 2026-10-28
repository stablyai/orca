import { lazy } from 'react'
import { useAppStore } from '../store'
import { ModalBoundary } from './app-root-surface-boundaries'

const DeleteMultiRepoWorkspaceDialog = lazy(
  () => import('../components/multi-repo/DeleteMultiRepoWorkspaceDialog')
)

export function MultiRepoDeleteModalHost(): React.JSX.Element | null {
  const isOpen = useAppStore((s) => s.activeModal === 'delete-multi-repo-workspace')
  if (!isOpen) {
    return null
  }
  return (
    <ModalBoundary boundaryId="modal.delete-multi-repo-workspace" resetKey>
      <DeleteMultiRepoWorkspaceDialog />
    </ModalBoundary>
  )
}
