import { ActionSheetModal, type ActionSheetAction } from '../components/ActionSheetModal'
import { ConfirmModal } from '../components/ConfirmModal'
import { PickerModal } from '../components/PickerModal'
import { MobilePrComposeSheet, openMobilePrUrl } from '../components/MobilePrComposeSheet'
import { MobileBranchDiffPreviewDrawer } from './MobileBranchDiffPreviewDrawer'
import type { MobileSourceControlState } from './use-mobile-source-control-state'

type Props = {
  state: MobileSourceControlState
  worktreeId: string
  actionSheetActions: ActionSheetAction[]
}

export function MobileSourceControlModals({ state, worktreeId, actionSheetActions }: Props) {
  const {
    client,
    branchDiffPreview,
    setBranchDiffPreview,
    showActionSheet,
    setShowActionSheet,
    discardTarget,
    setDiscardTarget,
    showPrSheet,
    setShowPrSheet,
    prPrefill,
    showBranchPicker,
    setShowBranchPicker,
    localBranches,
    createdPrUrl,
    setCreatedPrUrl,
    branchLabel,
    loadStatus,
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
        title="Source Control"
        message={branchLabel}
        actions={actionSheetActions}
        onClose={() => setShowActionSheet(false)}
      />

      <ConfirmModal
        visible={discardTarget !== null}
        title="Discard Change"
        message={
          discardTarget
            ? `Discard changes to "${discardTarget.path}"? This cannot be undone.`
            : undefined
        }
        confirmLabel="Discard"
        destructive
        onConfirm={() => {
          if (discardTarget) {
            void runGitAction(`discard:${discardTarget.path}`, 'git.discard', {
              filePath: discardTarget.path
            })
          }
        }}
        onCancel={() => setDiscardTarget(null)}
      />

      <MobilePrComposeSheet
        visible={showPrSheet}
        client={client}
        worktreeId={worktreeId ?? ''}
        prefill={prPrefill ?? { provider: 'github', base: 'main', title: branchLabel, body: '' }}
        onClose={() => setShowPrSheet(false)}
        onCreated={(url) => {
          setShowPrSheet(false)
          setCreatedPrUrl(url)
          void loadStatus({ preserveReadyOnFailure: true, force: true })
        }}
      />

      <PickerModal
        visible={showBranchPicker}
        title="Switch Branch"
        options={(localBranches?.branches ?? []).map((b) => ({
          value: b,
          label: b,
          subtitle: b === localBranches?.current ? 'current' : undefined
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
        title="Pull Request Created"
        message="Open it in your browser?"
        confirmLabel="Open"
        onConfirm={() => {
          if (createdPrUrl) {
            openMobilePrUrl(createdPrUrl)
          }
          setCreatedPrUrl(null)
        }}
        onCancel={() => setCreatedPrUrl(null)}
      />
    </>
  )
}
