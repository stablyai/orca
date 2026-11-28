import { useMemo, useState } from 'react'
import { CircleX, RefreshCw } from 'lucide-react-native'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { ConfirmModal } from '../../components/sheets/ConfirmModal'
import type { ActionSheetAction } from '../../components/sheets/ActionSheetModal'
import {
  isMobileConflictAborting,
  mobileConflictAbortLabel
} from '../conflicts/mobile-source-control-conflict-abort'
import { buildChangesMenuGroups } from '../workflows/mobile-source-control-actions'

type AbortableOperation = 'merge' | 'rebase'

/** The Changes ⋯ menu, and the confirm that guards Abort: it throws away the paused merge or rebase. */
export function useMobileSourceControlChangesMenu({
  gitMenu,
  busyAction,
  conflictOperation,
  onRefresh,
  abortConflictOperation
}: {
  gitMenu: { groups: ActionSheetAction[][]; forcePush: ActionSheetAction | null }
  busyAction: string | null
  conflictOperation: string | null | undefined
  onRefresh: () => void
  abortConflictOperation: (operation: AbortableOperation) => Promise<unknown> | void
}) {
  const t = useMobileTranslation()
  const [confirming, setConfirming] = useState<AbortableOperation | null>(null)
  const operation =
    conflictOperation === 'merge' || conflictOperation === 'rebase' ? conflictOperation : null
  const ioBusy = busyAction !== null
  const groups = useMemo(
    () =>
      buildChangesMenuGroups<ActionSheetAction & { id: string }>(
        {
          groups: gitMenu.groups.map((group) => group.map(withId)),
          forcePush: gitMenu.forcePush && withId(gitMenu.forcePush)
        },
        {
          refresh: {
            id: 'refresh',
            label: t('sourceControl.header.refresh', 'Refresh'),
            icon: RefreshCw,
            disabled: ioBusy,
            onPress: onRefresh
          },
          abort: operation
            ? {
                id: 'abort',
                label: mobileConflictAbortLabel(
                  operation,
                  isMobileConflictAborting(busyAction, operation),
                  t
                ),
                icon: CircleX,
                disabled: ioBusy,
                // The confirm presents only after the menu has closed.
                closeBeforePress: true,
                onPress: () => setConfirming(operation)
              }
            : null
        }
      ),
    [busyAction, gitMenu, ioBusy, onRefresh, operation, t]
  )
  const abortConfirm = (
    <ConfirmModal
      visible={confirming !== null}
      title={
        confirming === 'rebase'
          ? t('sourceControl.conflictAbort.confirmRebaseTitle', 'Abort the rebase?')
          : t('sourceControl.conflictAbort.confirmMergeTitle', 'Abort the merge?')
      }
      message={t(
        'sourceControl.conflictAbort.confirmMessage',
        'The branch goes back to where it was, and the resolved files are lost.'
      )}
      confirmLabel={mobileConflictAbortLabel(confirming ?? 'merge', false, t)}
      destructive
      onConfirm={() => {
        // The merge may have finished or changed while the confirm was up.
        if (confirming && confirming === operation && !ioBusy) {
          void abortConflictOperation(confirming)
        }
        setConfirming(null)
      }}
      onCancel={() => setConfirming(null)}
    />
  )
  return { groups, abortConfirm }
}

function withId(action: ActionSheetAction): ActionSheetAction & { id: string } {
  return { ...action, id: action.id ?? '' }
}
