import { ConfirmContent } from './ConfirmModal'
import type { RpcClient } from '../transport/rpc-client'

export function AddProjectFolderConfirmation({
  path,
  client,
  sshConnectionId,
  confirmingRef,
  onConfirmFolder,
  onChanged,
  onCancel
}: {
  path: string
  client: RpcClient | null
  sshConnectionId: string | null | undefined
  confirmingRef: { current: boolean }
  onConfirmFolder: () => void
  onChanged: () => void
  onCancel: () => void
}) {
  return (
    <ConfirmContent
      title="Add as a folder project?"
      message={`${path} is not a Git repository. Folder projects have no worktrees, source control, pull requests, or checks.`}
      confirmLabel="Add folder"
      onConfirm={() => {
        confirmingRef.current = true
        if (!client || sshConnectionId === undefined) {
          onChanged()
          confirmingRef.current = false
          return
        }
        onConfirmFolder()
      }}
      onCancel={onCancel}
    />
  )
}
