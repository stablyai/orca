import { ActionSheetModal, type ActionSheetAction } from '../components/ActionSheetModal'
import { ConfirmModal } from '../components/ConfirmModal'
import { PickerModal } from '../components/PickerModal'
import { openMobilePrUrl } from '../components/mobile-pr-url'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { MobileBranchDiffPreviewDrawer } from './MobileBranchDiffPreviewDrawer'
import type { MobileSourceControlState } from './use-mobile-source-control-state'

type Props = {
  state: MobileSourceControlState
  actionSheetActions: ActionSheetAction[]
}

export function MobileSourceControlModals({ state, actionSheetActions }: Props) {
  const t = useMobileTranslation()
  const {
    branchDiffPreview,
    setBranchDiffPreview,
    showActionSheet,
    setShowActionSheet,
    discardTarget,
    setDiscardTarget,
    showBranchPicker,
    setShowBranchPicker,
    localBranches,
    createdPrUrl,
    setCreatedPrUrl,
    createdPrWarning,
    setCreatedPrWarning,
    branchLabel,
    checkoutBranch,
    runGitAction
  } = state

  return (
    <>
      <MobileBranchDiffPreviewDrawer
        branchDiffPreview={branchDiffPreview}
        onClose={() => setBranchDiffPreview(null)}
      />

      <ActionSheetModal
        visible={showActionSheet}
        title={t('sourceControl.modals.actionsTitle', 'Source Control')}
        message={branchLabel}
        actions={actionSheetActions}
        onClose={() => setShowActionSheet(false)}
      />

      <ConfirmModal
        visible={discardTarget !== null}
        title={t('sourceControl.modals.discardTitle', 'Discard Change')}
        message={
          discardTarget
            ? t(
                'sourceControl.modals.discardConfirmMessage',
                'Discard changes to "{{path}}"? This cannot be undone.',
                { path: discardTarget.path }
              )
            : undefined
        }
        confirmLabel={t('sourceControl.modals.discardButton', 'Discard')}
        destructive
        onConfirm={() => {
          if (discardTarget) {
            void runGitAction(`discard:${discardTarget.path}`, 'git.discard', {
              filePath: discardTarget.path
            })
          }
          setDiscardTarget(null)
        }}
        onCancel={() => setDiscardTarget(null)}
      />

      <PickerModal
        visible={showBranchPicker}
        title={t('sourceControl.modals.switchBranchTitle', 'Switch Branch')}
        options={(localBranches?.branches ?? []).map((b) => ({
          value: b,
          label: b,
          subtitle:
            b === localBranches?.current
              ? t('sourceControl.modals.currentBranch', 'current')
              : undefined
        }))}
        selected={localBranches?.current ?? ''}
        onSelect={(branch) => {
          if (branch !== localBranches?.current) {
            void checkoutBranch(branch)
          } else {
            setShowBranchPicker(false)
          }
        }}
        onClose={() => setShowBranchPicker(false)}
      />

      <ConfirmModal
        visible={createdPrUrl !== null}
        title={t('sourceControl.modals.prCreatedTitle', 'Pull Request Created')}
        message={
          createdPrWarning
            ? t(
                'sourceControl.modals.openPrWithWarning',
                'Open it in your browser?\n\n{{warning}}',
                {
                  warning: createdPrWarning
                }
              )
            : t('sourceControl.modals.openPrMessage', 'Open it in your browser?')
        }
        confirmLabel={t('common.open', 'Open')}
        onConfirm={() => {
          if (createdPrUrl) {
            openMobilePrUrl(createdPrUrl)
          }
          setCreatedPrUrl(null)
          setCreatedPrWarning(null)
        }}
        onCancel={() => {
          setCreatedPrUrl(null)
          setCreatedPrWarning(null)
        }}
      />
    </>
  )
}
