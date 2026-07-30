import { ActionSheetModal, type ActionSheetAction } from '../components/ActionSheetModal'
import { ConfirmModal } from '../components/ConfirmModal'
import { PickerModal } from '../components/PickerModal'
import { openMobilePrUrl } from '../components/MobilePrComposeSheet'
import { MobileBranchDiffPreviewDrawer } from './MobileBranchDiffPreviewDrawer'
import type { MobileSourceControlState } from './use-mobile-source-control-state'
import { t } from '@/i18n/mobile-i18n'

type Props = {
  state: MobileSourceControlState
  actionSheetActions: ActionSheetAction[]
}

export function MobileSourceControlModals({ state, actionSheetActions }: Props) {
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
        title={t('m.7p6X0C0')}
        message={branchLabel}
        actions={actionSheetActions}
        onClose={() => setShowActionSheet(false)}
      />

      <ConfirmModal
        visible={discardTarget !== null}
        title={t('m.7IMotMA')}
        message={discardTarget ? t('m.Oh7cEhY', { value0: discardTarget.path }) : undefined}
        confirmLabel={t('m.aalP-X8')}
        destructive
        onConfirm={() => {
          if (discardTarget) {
            void runGitAction(`discard:${discardTarget.path}`, 'git.discard', {
              filePath: discardTarget.path
            })
          }
          // Modal visibility is derived from discardTarget — clear it so it dismisses.
          setDiscardTarget(null)
        }}
        onCancel={() => setDiscardTarget(null)}
      />

      <PickerModal
        visible={showBranchPicker}
        title={t('m.n9UDFoo')}
        options={(localBranches?.branches ?? []).map((b) => ({
          value: b,
          label: b,
          subtitle: b === localBranches?.current ? t('m.2t3siE4') : undefined
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
        title={t('m.4E80Be4')}
        message={createdPrWarning ? t('m.671hHtA', { value0: createdPrWarning }) : t('m.84pwQsY')}
        confirmLabel={t('m._c5oKe0')}
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
