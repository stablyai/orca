import { useMemo, useState } from 'react'
import { KeyboardAvoidingView, Pressable, Text, View } from 'react-native'
import { Copy, Plus, Send } from 'lucide-react-native'
import { getRuntimePathBasename } from '../../../../../src/shared/file-access/cross-platform-path'
import { useMobileColors } from '../../../theme/use-mobile-color-scheme'
import { sendSheetMessage } from './mobile-diff-review-send-copy'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import type { ActionSheetAction } from '../../../components/sheets/ActionSheetModal'
import { ActionSheetContent } from '../../../components/sheets/ActionSheetModal'
import { ConfirmContent } from '../../../components/sheets/ConfirmModal'
import { KeyedBottomDrawer } from '../../../components/bottom-drawer/keyed-bottom-drawer'
import type { ComposerState, SendSheetState } from '../diff-state/mobile-diff-review-screen-model'
import { reviewSheetKey, type ReviewSheet } from '../diff-actions/mobile-diff-review-sheets'
import type { useMobileDiffReviewController } from '../use-mobile-diff-review-controller'
import { mobileDiffReviewStylesSheet } from './mobile-diff-review-screen-styles'
import { TextField } from '../../../components/composer-input/TextField'
import { ListGroup, ListRow } from '../../../components/list/ListGroup'
import { SheetHeader } from '../../../components/nav-bar/SheetHeader'
import { prSheetStylesSheet } from '../pull-request/pr-tab-styles'
import { useThemedStyles } from '../../../theme/themed-styles'
import { hostOs } from '../../../platform/host-os'
import { MobileDiffReviewFilesSheet } from './MobileDiffReviewFilesSheet'
import { MobileDiffReviewRangeSheet } from './MobileDiffReviewRangeSheet'
import { mobileDiffReviewFilesSubtitle } from '../diff-state/mobile-diff-review-screen-model'

type Props = {
  controller: ReturnType<typeof useMobileDiffReviewController>
}

export function MobileDiffReviewDrawers({ controller }: Props) {
  // Jump to file stays full height through its close, after the request has cleared.
  const [lastKind, setLastKind] = useState<ReviewSheet['kind'] | null>(null)
  if (controller.sheet && controller.sheet.kind !== lastKind) {
    setLastKind(controller.sheet.kind)
  }
  const filesSheet = (controller.sheet?.kind ?? lastKind) === 'files'
  // One drawer for every review sheet: iOS cannot present a sheet while another is still closing.
  return (
    <KeyedBottomDrawer
      sheet={controller.sheet}
      sheetKey={reviewSheetKey}
      onClose={(presented) => controller.closeSheet(presented.kind)}
      fillAvailable={filesSheet}
      contentScrollable={!filesSheet}
      dragContentToDismiss={!filesSheet}
    >
      {(presented) => <ReviewSheetContent controller={controller} sheet={presented} />}
    </KeyedBottomDrawer>
  )
}

function ReviewSheetContent({ controller, sheet }: Props & { sheet: ReviewSheet }) {
  const t = useMobileTranslation()
  switch (sheet.kind) {
    case 'send':
      return <SendNotesContent controller={controller} load={sheet.load} only={sheet.only} />
    case 'discard':
      return (
        <ConfirmContent
          title={t('components.diffReviewDrawers.discardTitle', 'Discard File')}
          message={t(
            'components.diffReviewDrawers.discardMessage',
            'Discard changes to "{{filePath}}"? This cannot be undone.',
            { filePath: sheet.target.filePath }
          )}
          confirmLabel={t('components.diffReviewDrawers.discard', 'Discard')}
          destructive
          onConfirm={() => {
            controller.closeSheet('discard')
            void controller.runGitMutation('git.discard', sheet.target)
          }}
          onCancel={() => controller.closeSheet('discard')}
        />
      )
    case 'composer':
      return <NoteComposerContent controller={controller} composer={sheet.composer} />
    case 'completion':
      return <CompletionContent controller={controller} />
    case 'range':
      return <MobileDiffReviewRangeSheet controller={controller} range={sheet} />
    case 'files':
      return (
        <MobileDiffReviewFilesSheet
          queue={controller.filteredQueue}
          currentKey={controller.currentItem?.key ?? null}
          subtitle={mobileDiffReviewFilesSubtitle(
            {
              scope: controller.currentItem?.scope ?? null,
              count: controller.filteredQueue.length,
              viewedCount: controller.reviewedCount
            },
            t
          )}
          onSelect={(item) => {
            controller.selectItem(item)
            controller.closeSheet('files')
          }}
          onToggleViewed={(item) => void controller.toggleItemViewed(item)}
          onClose={() => controller.closeSheet('files')}
        />
      )
  }
}

function SendNotesContent({
  controller,
  load,
  only
}: Props & { load: SendSheetState; only?: readonly string[] }) {
  const t = useMobileTranslation()
  const sendActions = useSendActions(controller, load, only)
  return (
    <ActionSheetContent
      title={t('components.diffReviewDrawers.sendNotes', 'Send Notes')}
      message={sendSheetMessage(t, controller, load)}
      actions={sendActions}
      onClose={() => controller.closeSheet('send')}
    />
  )
}

function useSendActions(
  controller: ReturnType<typeof useMobileDiffReviewController>,
  load: SendSheetState,
  only: readonly string[] | undefined
) {
  const t = useMobileTranslation()
  return useMemo<ActionSheetAction[]>(() => {
    const comments = only
      ? controller.unsentComments.filter((comment) => only.includes(comment.id))
      : controller.unsentComments
    const terminalActions =
      load.kind === 'ready' || load.kind === 'error'
        ? load.terminals.map((terminal) => ({
            id: `terminal:${terminal.terminal}`,
            label: t('components.diffReviewDrawers.terminalLabel', '{{title}} ({{id}})', {
              title: terminal.title || t('components.diffReviewDrawers.terminal', 'Terminal'),
              id: terminal.terminal.slice(0, 6)
            }),
            icon: Send,
            disabled: comments.length === 0,
            skipAutoClose: true,
            onPress: () => void controller.sendPromptToTerminal(terminal.terminal, comments)
          }))
        : []
    return [
      ...terminalActions,
      {
        id: 'newAgentSession',
        label: t('components.diffReviewDrawers.newAgentSession', 'New Agent Session'),
        icon: Plus,
        disabled: comments.length === 0 || controller.agentLaunchAvailability !== 'available',
        ...(controller.agentLaunchAvailability === 'update-required'
          ? {
              hint: t('components.diffReviewDrawers.updateRequired', 'Update Orca on this host')
            }
          : controller.agentLaunchAvailability === 'unverified'
            ? {
                hint: t(
                  'components.diffReviewDrawers.statusUnreadable',
                  "Could not read this host's status. Retrying…"
                )
              }
            : {}),
        skipAutoClose: true,
        onPress: () => void controller.createTerminalAndSend(comments)
      },
      {
        id: 'copyNotes',
        label: t('components.diffReviewDrawers.copyNotes', 'Copy Notes'),
        icon: Copy,
        // A sheet for one new note copies that note, not every note in the workspace.
        disabled: only
          ? comments.length === 0
          : controller.screenState.kind !== 'ready' || controller.screenState.comments.length === 0,
        onPress: () => void controller.copyNotes(only ? comments : undefined)
      }
    ]
  }, [controller, load, only, t])
}

function NoteComposerContent({ controller, composer }: Props & { composer: ComposerState }) {
  const styles = useThemedStyles(mobileDiffReviewStylesSheet)
  const prSheetStyles = useThemedStyles(prSheetStylesSheet)
  const t = useMobileTranslation()
  const [busy, setBusy] = useState(false)
  const run = (action: () => Promise<void>) => {
    setBusy(true)
    // A failed save shows in the screen's error line; the sheet stays open with the text.
    void action()
      .catch(() => {})
      .finally(() => setBusy(false))
  }
  return (
    <KeyboardAvoidingView behavior={hostOs() === 'ios' ? 'padding' : undefined}>
      <SheetHeader
        title={
          composer.mode === 'edit'
            ? t('components.diffReviewDrawers.editNote', 'Edit note')
            : t('components.diffReviewDrawers.fileNote', 'File note')
        }
        {...(controller.currentItem
          ? { subtitle: getRuntimePathBasename(controller.currentItem.filePath) }
          : {})}
        leading={{ label: t('common.cancel', 'Cancel'), onPress: controller.closeComposer }}
        trailing={{
          label: t('common.save', 'Save'),
          onPress: () => run(controller.saveComposer),
          busy,
          disabled: !controller.composerBody.trim()
        }}
      />
      <View style={prSheetStyles.body}>
        <TextField
          value={controller.composerBody}
          onChangeText={controller.setComposerBody}
          autoFocus
          multiline
          placeholder={t('components.diffReviewDrawers.reviewNote', 'Review note')}
          accessibilityLabel={t('components.diffReviewDrawers.reviewNote', 'Review note')}
          style={styles.rangeField}
        />
        {composer.mode === 'edit' ? (
          <ListGroup>
            <ListRow
              title={t('components.diffReviewDrawers.deleteNote', 'Delete note')}
              destructive
              disabled={busy}
              onPress={() => run(controller.deleteComment)}
            />
          </ListGroup>
        ) : null}
      </View>
    </KeyboardAvoidingView>
  )
}

function CompletionContent({ controller }: Props) {
  const styles = useThemedStyles(mobileDiffReviewStylesSheet)
  const colors = useMobileColors()
  const t = useMobileTranslation()
  const fileCount = controller.filteredQueue.length
  const count = controller.screenState.kind === 'ready' ? controller.screenState.comments.length : 0
  const files =
    fileCount === 1
      ? t('components.diffReviewDrawers.viewedFiles_one', '{{count}} file viewed', {
          count: fileCount
        })
      : t('components.diffReviewDrawers.viewedFiles_other', '{{count}} files viewed', {
          count: fileCount
        })
  const notes =
    count === 1
      ? t('components.diffReviewDrawers.notes_one', '{{count}} note', { count })
      : t('components.diffReviewDrawers.notes_other', '{{count}} notes', { count })
  return (
    <>
      <Text style={styles.drawerTitle}>
        {t('components.diffReviewDrawers.allViewedTitle', 'All files viewed')}
      </Text>
      <Text style={styles.drawerSubtitle}>{`${files} · ${notes}`}</Text>
      {/* With every note sent there is nothing to send, so no button. */}
      {controller.unsentComments.length > 0 ? (
        <View style={styles.drawerButtonRow}>
          <Pressable
            style={({ pressed }) => [styles.primaryButton, pressed && styles.buttonPressed]}
            onPress={() => void controller.openSendSheet()}
            accessibilityRole="button"
            accessibilityLabel={t(
              'components.diffReviewDrawers.sendNotesLabel',
              'Send notes to agent'
            )}
          >
            <Send size={14} color={colors.bgBase} strokeWidth={2.2} />
            <Text style={styles.primaryButtonText}>
              {t('components.diffReviewDrawers.sendNotes', 'Send Notes')}
            </Text>
          </Pressable>
        </View>
      ) : null}
    </>
  )
}
