import { useState } from 'react'
import { Text, View } from 'react-native'
import { GitMerge } from 'lucide-react-native'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import type { Translate } from '../../i18n/mobile-i18n'
import type { GitHubPRMergeMethod } from '../../../../src/shared/github/pull-request-types'
import { resolveGitHubPRMergeMethods } from '../../../../src/shared/github/pull-request-merge-methods'
import { KeyedBottomDrawer } from '../keyed-bottom-drawer'
import { SheetHeader } from '../nav-bar/SheetHeader'
import { SheetPrimaryButton } from '../SheetPrimaryButton'
import { ListGroup, ListRow } from '../list/ListGroup'
import { ConfirmModal } from '../ConfirmModal'
import { presentPrMerge } from './pr-actions-state'
import { PrCreateSheet } from './PrCreateSheet'
import { PrReviewersSheet } from './PrReviewersSheet'
import { livePrDetails, readyPrData, type MobilePrTab, type PrTabSheet } from './use-mobile-pr-tab'
import { prSheetStyles as sheetStyles } from './pr-tab-styles'
import { FieldTextInput } from '../composer-input/FieldTextInput'

// Sheets for the PR tab's decisions; one Modal swaps between them so iOS never stacks presentations.
export function MobilePrTabSheets({ tab }: { tab: MobilePrTab }) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  return (
    <>
      <KeyedBottomDrawer
        sheet={tab.sheet}
        sheetKey={(sheet: PrTabSheet) => sheet}
        onClose={tab.closeSheet}
        onAfterClose={tab.onSheetAfterClose}
        dismissible={!tab.creatingPr}
        dragContentToDismiss={false}
      >
        {(sheet) => {
          switch (sheet) {
            case 'merge':
              return <PrMergeSheet tab={tab} />
            case 'reviewers':
              return <PrReviewersSheet tab={tab} />
            case 'editTitle':
              return <PrEditTextSheet tab={tab} field="title" />
            case 'editDescription':
              return <PrEditTextSheet tab={tab} field="body" />
            case 'createPr':
              return <PrCreateSheet tab={tab} />
          }
        }}
      </KeyedBottomDrawer>
      <PrTabConfirm tab={tab} t={t} />
    </>
  )
}

function mergeMethodCopy(
  method: GitHubPRMergeMethod,
  base: string,
  t: Translate
): { title: string; subtitle: string } {
  switch (method) {
    case 'squash':
      return {
        title: t('pullRequest.prActionsState.methodSquash', 'Squash and merge'),
        subtitle: t('pullRequest.mergeSheet.squashDetail', 'One commit on {{base}}', { base })
      }
    case 'merge':
      return {
        title: t('pullRequest.prActionsState.methodMerge', 'Create merge commit'),
        subtitle: t('pullRequest.mergeSheet.mergeDetail', 'Keeps every commit')
      }
    case 'rebase':
      return {
        title: t('pullRequest.prActionsState.methodRebase', 'Rebase and merge'),
        subtitle: t('pullRequest.mergeSheet.rebaseDetail', 'Replays each commit onto {{base}}', {
          base
        })
      }
  }
}

// Lists only the methods the repo allows, starting on its default; mobile used to merge with the default only.
function PrMergeSheet({ tab }: { tab: MobilePrTab }) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const data = readyPrData(tab)
  const settings = data?.pr.mergeMethodSettings ?? null
  const { defaultMethod, methods } = resolveGitHubPRMergeMethods(settings)
  const [method, setMethod] = useState<GitHubPRMergeMethod>(defaultMethod)
  const [submitted, setSubmitted] = useState(false)
  if (!data) {
    return null
  }
  const pr = data.pr
  const base = pr.baseRefName ?? 'main'
  const merge = presentPrMerge({ ...pr, state: tab.actions.resolveState(pr.state) }, method)
  const busy = tab.actions.isBusy({ kind: 'merge' })
  const run = async () => {
    setSubmitted(true)
    if (await tab.actions.merge(method)) {
      tab.closeSheetIf('merge')
    }
  }
  return (
    <View>
      <SheetHeader
        title={t('pullRequest.mergeSheet.title', 'Merge #{{number}}', { number: pr.number })}
        subtitle={t('pullRequest.mergeSheet.subtitle', 'Into {{base}}', { base })}
        trailing={{ label: t('common.cancel', 'Cancel'), onPress: tab.closeSheet }}
      />
      <View style={sheetStyles.body}>
        <ListGroup>
          {methods.map((value) => {
            const copy = mergeMethodCopy(value, base, t)
            return (
              <ListRow
                key={value}
                title={copy.title}
                subtitle={copy.subtitle}
                selected={value === method}
                accessibilityRole="radio"
                onPress={() => setMethod(value)}
                disabled={busy}
              />
            )
          })}
        </ListGroup>
        {pr.stack ? <Text style={sheetStyles.note}>{merge.confirmMessage}</Text> : null}
        {submitted && tab.actions.error ? (
          <Text style={sheetStyles.error}>{tab.actions.error}</Text>
        ) : !merge.enabled && merge.hint ? (
          <Text style={sheetStyles.note}>{merge.hint}</Text>
        ) : null}
        <SheetPrimaryButton
          tone="merge"
          icon={GitMerge}
          label={merge.label}
          busy={busy}
          disabled={!merge.enabled}
          onPress={() => void run()}
        />
      </View>
    </View>
  )
}

function PrEditTextSheet({ tab, field }: { tab: MobilePrTab; field: 'title' | 'body' }) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const data = readyPrData(tab)
  const details = livePrDetails(data?.details ?? null)
  const current =
    field === 'title' ? (details?.item.title ?? data?.pr.title ?? '') : (details?.body ?? '')
  const [draft, setDraft] = useState(current)
  const { textAction } = tab
  const save = async () => {
    if (await textAction.save(field, draft, current)) {
      tab.closeSheetIf(field === 'title' ? 'editTitle' : 'editDescription')
    }
  }
  const cancel = () => {
    textAction.clearError()
    tab.closeSheet()
  }
  return (
    <View>
      <SheetHeader
        title={
          field === 'title'
            ? t('pullRequest.editSheet.title', 'Edit title')
            : t('pullRequest.editSheet.description', 'Edit description')
        }
        subtitle={data ? `#${data.pr.number}` : undefined}
        leading={{ label: t('common.cancel', 'Cancel'), onPress: cancel }}
        trailing={{
          label: t('common.save', 'Save'),
          onPress: () => void save(),
          busy: textAction.saving,
          disabled: field === 'title' && draft.trim().length === 0
        }}
      />
      <View style={sheetStyles.body}>
        <FieldTextInput
          value={draft}
          onChangeText={setDraft}
          editable={!textAction.saving}
          autoFocus
          multiline={field === 'body'}
          style={[sheetStyles.field, field === 'body' && sheetStyles.multiline]}
        />
        {textAction.error ? <Text style={sheetStyles.error}>{textAction.error}</Text> : null}
      </View>
    </View>
  )
}

function PrTabConfirm({ tab, t }: { tab: MobilePrTab; t: Translate }) {
  const number = tab.state.kind === 'ready' ? tab.state.data.pr.number : 0
  const copy =
    tab.confirm === 'close'
      ? {
          title: t('pullRequest.prActionsSection.closeConfirmTitle', 'Close pull request?'),
          message: t(
            'pullRequest.prActionsSection.closeConfirmMessage',
            '#{{number}} will be closed without merging.',
            { number }
          ),
          confirmLabel: t('common.close', 'Close')
        }
      : tab.confirm === 'unlink'
        ? {
            title: t('pullRequest.tab.unlinkConfirmTitle', 'Unlink pull request?'),
            message: t(
              'pullRequest.tab.unlinkConfirmMessage',
              '#{{number}} stays open on GitHub; this workspace stops tracking it.',
              { number }
            ),
            confirmLabel: t('pullRequest.prActionsSection.unlinkButton', 'Unlink')
          }
        : {
            title: t('pullRequest.prActionsSection.reopenConfirmTitle', 'Reopen pull request?'),
            message: t(
              'pullRequest.prActionsSection.reopenConfirmMessage',
              '#{{number}} will be reopened.',
              { number }
            ),
            confirmLabel: t('pullRequest.prActionsSection.reopenButton', 'Reopen')
          }
  return (
    <ConfirmModal
      visible={tab.confirm !== null}
      title={copy.title}
      message={copy.message}
      confirmLabel={copy.confirmLabel}
      destructive={tab.confirm === 'close'}
      onConfirm={() => {
        if (tab.confirm === 'unlink') {
          void tab.unlink()
        } else if (tab.confirm) {
          tab.actions.updateState(tab.confirm === 'close' ? 'closed' : 'open')
        }
        tab.setConfirm(null)
      }}
      onCancel={() => tab.setConfirm(null)}
    />
  )
}
