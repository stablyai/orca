import { useEffect, useRef, useState } from 'react'
import { getWorktreeGitIdentityDisplay } from '../../../src/shared/worktree/git-identity-display'
import { TextInputSheetContent } from '../components/TextInputModal'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { Worktree } from '../worktree/workspace-list-types'

// Swapped into the workspace menu's open drawer; unmounting it is the cancel.
export function WorkspaceRenameSheet({
  row,
  rename,
  onDone,
  onCancel
}: {
  row: Worktree
  rename: (row: Worktree, displayName: string) => Promise<void>
  onDone: () => void
  onCancel: () => void
}) {
  const t = useMobileTranslation()
  const [value, setValue] = useState(row.displayName)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // The host's automatic name (mergeWorktree): the branch, else the project's name.
  const identity = getWorktreeGitIdentityDisplay({ branch: row.branch })
  const automaticName = identity?.kind === 'branch' ? identity.branchName : row.repo

  async function submit(displayName: string) {
    // Like desktop's Workspace details, an unchanged name is not written (it would pin the label).
    if (displayName === row.displayName) {
      onDone()
      return
    }
    setBusy(true)
    setError(null)
    try {
      await rename(row, displayName)
      if (mountedRef.current) {
        onDone()
      }
    } catch (failure) {
      if (!mountedRef.current) {
        return
      }
      const reason = failure instanceof Error ? failure.message : ''
      setError(
        reason
          ? t(
              'hostScreen.workspaceRenameSheet.failedWithReason',
              "Couldn't rename the workspace. {{reason}}",
              { reason }
            )
          : t('hostScreen.workspaceRenameSheet.failed', "Couldn't rename the workspace.")
      )
      setBusy(false)
    }
  }

  return (
    <TextInputSheetContent
      title={t('hostScreen.workspaceRenameSheet.title', 'Rename Workspace')}
      message={
        identity?.kind === 'branch'
          ? t(
              'hostScreen.workspaceRenameSheet.emptyUsesBranch',
              'Leave empty to use the branch name.'
            )
          : row.detachedHead
            ? undefined
            : t(
                'hostScreen.workspaceRenameSheet.emptyUsesFolder',
                'Leave empty to use the folder name.'
              )
      }
      value={value}
      onChangeText={setValue}
      placeholder={automaticName}
      submitLabel={error ? t('common.retry', 'Retry') : undefined}
      selectTextOnFocus
      allowEmpty
      error={error}
      busy={busy}
      onSubmit={(displayName) => void submit(displayName)}
      onCancel={onCancel}
    />
  )
}
