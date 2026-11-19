import { ConfirmModal } from '../../components/sheets/ConfirmModal'
import { PickerModal } from '../../components/sheets/PickerModal'
import { openExternalLink as openMobilePrUrl } from '../../platform/external-links/external-link'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import type { MobileSourceControlState } from '../use-mobile-source-control-state'
import type { Translate } from '../../i18n/mobile-i18n'
import { sequencerLabel } from '../conflicts/MobileSequencerRecoveryButtons'
import type { DiscardAllArea } from '../../../../src/shared/source-control/listing/source-control-discard-all-sequence'

type Props = {
  state: MobileSourceControlState
}

export function MobileSourceControlModals({ state }: Props) {
  const t = useMobileTranslation()
  const {
    discardTarget,
    setDiscardTarget,
    discardAllTarget,
    setDiscardAllTarget,
    discardAll,
    sequencerAbortTarget,
    setSequencerAbortTarget,
    abortConflictOperation,
    showBranchPicker,
    setShowBranchPicker,
    localBranches,
    createdPrUrl,
    setCreatedPrUrl,
    createdPrWarning,
    setCreatedPrWarning,
    checkoutBranch,
    runGitAction
  } = state

  return (
    <>
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

      <ConfirmModal
        visible={discardAllTarget !== null}
        {...(discardAllTarget
          ? discardAllCopy(discardAllTarget.area, discardAllTarget.paths.length, t)
          : { title: '' })}
        destructive
        onConfirm={() => {
          if (discardAllTarget) {
            void discardAll(discardAllTarget.area, discardAllTarget.paths)
          }
          setDiscardAllTarget(null)
        }}
        onCancel={() => setDiscardAllTarget(null)}
      />

      <ConfirmModal
        visible={sequencerAbortTarget !== null}
        title={t('sourceControl.changesHeader.abortSequencerTitle', 'Abort {{operation}}?', {
          operation: sequencerAbortTarget ? sequencerLabel(sequencerAbortTarget, t) : ''
        })}
        message={t(
          'sourceControl.changesHeader.abortSequencerMessage',
          'This cancels the operation in progress and can discard conflict resolutions made during it.'
        )}
        confirmLabel={t(
          'sourceControl.changesHeader.abortSequencerConfirm',
          'Abort {{operation}}',
          {
            operation: sequencerAbortTarget ? sequencerLabel(sequencerAbortTarget, t) : ''
          }
        )}
        destructive
        onConfirm={() => {
          if (sequencerAbortTarget) {
            void abortConflictOperation(sequencerAbortTarget)
          }
          setSequencerAbortTarget(null)
        }}
        onCancel={() => setSequencerAbortTarget(null)}
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

// Desktop's discard-all confirmation copy (discard-confirmation.ts), with the file count it shows.
function discardAllCopy(
  area: DiscardAllArea,
  count: number,
  t: Translate
): { title: string; message: string; confirmLabel: string } {
  const files =
    count === 1
      ? t('sourceControl.modals.discardAllFileCount_one', '{{count}} file', { count })
      : t('sourceControl.modals.discardAllFileCount_other', '{{count}} files', { count })
  const confirmLabel = t('sourceControl.modals.discardAllButton', 'Discard all')
  if (area === 'staged') {
    return {
      title: t('sourceControl.modals.discardAllStagedTitle', 'Discard all staged changes?'),
      message: `${t(
        'sourceControl.modals.discardAllStagedMessage',
        'This will unstage and revert all staged changes. Staged new files will be deleted. This cannot be undone.'
      )}\n\n${files}`,
      confirmLabel
    }
  }
  return {
    title: t('sourceControl.modals.discardAllUnstagedTitle', 'Discard all unstaged changes?'),
    message: `${
      count === 1
        ? t(
            'sourceControl.modals.discardAllUnstagedMessage_one',
            'This will revert unstaged changes and permanently delete any untracked files in this selection. This cannot be undone.'
          )
        : t(
            'sourceControl.modals.discardAllUnstagedMessage_other',
            'This will revert unstaged changes and permanently delete any untracked files among these {{count}} files. This cannot be undone.',
            { count }
          )
    }\n\n${files}`,
    confirmLabel
  }
}
