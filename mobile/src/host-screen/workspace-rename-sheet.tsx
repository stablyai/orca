import { useEffect, useRef, useState } from 'react'
import { automaticWorktreeDisplayName } from '../../../src/shared/worktree/display-name-provenance'
import { draftRenameSheetState } from '../components/draft-rename-sheet-state'
import { TextInputSheetContent } from '../components/TextInputModal'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { HostMutationPhase } from '../query/host-mutation'
import { readHostMutationDraft, setHostMutationDraft } from '../query/host-mutation-drafts'
import { isHostNotConnectedError } from '../query/host-query-errors'
import type { Worktree } from '../worktree/workspace-list-types'
import { getWorktreeRowIdentity } from '../worktree/worktree-host-row-identity'

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
  const draftKey = workspaceRenameDraftKey(hostId, row)
  // Opens on the name the desktop never took, if there is one.
  const [value, setValue] = useState(() => readHostMutationDraft(draftKey) ?? row.displayName)
  const [phase, setPhase] = useState<HostMutationPhase>('idle')
  const busy = phase !== 'idle'
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

  const sheet = draftRenameSheetState({ blockedOffline, phase, error, hostName, t })
  // Text the desktop couldn't take yet comes back next time, however the drawer closes; a plain Cancel drops it.
  const waiting = sheet.submitBlocked || sheet.notice !== null
  const unsaved = waiting && value.trim() !== row.displayName ? value : null
  const unsavedRef = useRef(unsaved)
  useEffect(() => {
    unsavedRef.current = unsaved
  })
  useEffect(() => () => setHostMutationDraft(draftKey, unsavedRef.current), [draftKey])

  async function submit(displayName: string) {
    // Like desktop's Workspace details, an unchanged name is not written (it would pin the label).
    if (displayName === row.displayName) {
      onClose()
      return
    }
    setPhase('pending')
    setError(null)
    try {
      await rename(row, displayName, (next) => {
        if (mountedRef.current) {
          setPhase(next)
        }
      })
      unsavedRef.current = null
      setHostMutationDraft(draftKey, null)
      // A late success must not close a menu reopened since.
      if (mountedRef.current) {
        onClose()
      }
    } catch (failure) {
      if (!mountedRef.current) {
        return
      }
      // Offline before it was sent: the offline notice says why, and the text waits.
      if (!isHostNotConnectedError(failure)) {
        const reason = failure instanceof Error ? failure.message : ''
        setError(
          t('hostScreen.workspaceRenameSheet.failed', "Couldn't rename the workspace. {{reason}}", {
            reason
          }).trim()
        )
      }
      setPhase('idle')
    }
  }

  return (
    <TextInputSheetContent
      title={t('hostScreen.workspaceRenameSheet.title', 'Rename Workspace')}
      message={hint}
      value={value}
      onChangeText={setValue}
      placeholder={automaticName}
      selectTextOnFocus
      allowEmpty
      error={error}
      busy={busy}
      {...sheet}
      onSubmit={(displayName) => void submit(displayName)}
      onCancel={onClose}
    />
  )
}
