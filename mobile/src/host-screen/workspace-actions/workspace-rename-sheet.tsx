import { automaticWorktreeDisplayName } from '../../../../src/shared/worktree/metadata/display-name-provenance'
import { TextInputSheetContent } from '../../components/TextInputModal'
import { useDraftRenameSheet } from '../../components/rename/use-draft-rename-sheet'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import type { HostMutationPhase } from '../../query/host-mutation'
import type { Worktree } from '../../worktree/workspace-list/workspace-list-types'
import { getWorktreeRowIdentity } from '../../worktree/row-presentation/worktree-host-row-identity'

export function workspaceRenameDraftKey(hostId: string, row: Worktree): string {
  return `workspace-rename:${hostId}:${getWorktreeRowIdentity(row)}`
}

// Swapped into the workspace menu's open drawer.
export function WorkspaceRenameSheet({
  hostId,
  hostName,
  row,
  rename,
  blockedOffline,
  onClose
}: {
  hostId: string
  hostName: string
  row: Worktree
  rename: (
    row: Worktree,
    displayName: string,
    onPhase: (phase: HostMutationPhase) => void
  ) => Promise<void>
  blockedOffline: boolean
  onClose: () => void
}) {
  const t = useMobileTranslation()
  const sheet = useDraftRenameSheet({
    draftKey: workspaceRenameDraftKey(hostId, row),
    currentName: row.displayName,
    blockedOffline,
    hostName,
    failureMessage: (reason) =>
      t('hostScreen.workspaceRenameSheet.failed', "Couldn't rename the workspace. {{reason}}", {
        reason
      }),
    rename: (displayName, onPhase) => rename(row, displayName, onPhase),
    onRenamed: onClose
  })

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

  return (
    <TextInputSheetContent
      title={t('hostScreen.workspaceRenameSheet.title', 'Rename Workspace')}
      message={hint}
      placeholder={automaticName}
      selectTextOnFocus
      allowEmpty
      {...sheet.sheetProps}
      onSubmit={(displayName) =>
        // Like desktop's Workspace details, an unchanged name is not written (it would pin the label).
        displayName === row.displayName ? onClose() : void sheet.submit(displayName)
      }
      onCancel={onClose}
    />
  )
}
