import { useEffect, useRef, useState } from 'react'
import { automaticWorktreeDisplayName } from '../../../src/shared/worktree/display-name-provenance'
import { TextInputSheetContent } from '../components/TextInputModal'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { Worktree } from '../worktree/workspace-list-types'

// Swapped into the workspace menu's open drawer.
export function WorkspaceRenameSheet({
  row,
  rename,
  onClose
}: {
  row: Worktree
  rename: (row: Worktree, displayName: string) => Promise<void>
  onClose: () => void
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

  const automaticName = automaticWorktreeDisplayName({
    branch: row.branch,
    projectName: row.repo,
    path: row.path
  })
  // A detached HEAD falls back to the project's name, which neither hint describes.
  const hint = row.branch
    ? t('hostScreen.workspaceRenameSheet.emptyUsesBranch', 'Leave empty to use the branch name.')
    : row.detachedHead
      ? undefined
      : t('hostScreen.workspaceRenameSheet.emptyUsesFolder', 'Leave empty to use the folder name.')

  async function submit(displayName: string) {
    // Like desktop's Workspace details, an unchanged name is not written (it would pin the label).
    if (displayName === row.displayName) {
      onClose()
      return
    }
    setBusy(true)
    setError(null)
    try {
      await rename(row, displayName)
      // A late success must not close a menu reopened since.
      if (mountedRef.current) {
        onClose()
      }
    } catch (failure) {
      const reason = failure instanceof Error ? failure.message : ''
      setError(
        t('hostScreen.workspaceRenameSheet.failed', "Couldn't rename the workspace. {{reason}}", {
          reason
        }).trim()
      )
      setBusy(false)
    }
  }

  return (
    <TextInputSheetContent
      title={t('hostScreen.workspaceRenameSheet.title', 'Rename Workspace')}
      message={hint}
      value={value}
      onChangeText={setValue}
      placeholder={automaticName}
      submitLabel={error ? t('common.retry', 'Retry') : undefined}
      selectTextOnFocus
      allowEmpty
      error={error}
      busy={busy}
      onSubmit={(displayName) => void submit(displayName)}
      onCancel={onClose}
    />
  )
}
