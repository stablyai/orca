import { useMemo } from 'react'
import { KeyboardAvoidingView, Platform, Pressable, Text, TextInput, View } from 'react-native'
import { Check, Copy, FileText, Plus, Send, Trash2, X } from 'lucide-react-native'
import type { DiffComment } from '../../../src/shared/types'
import { useTranslate } from '../i18n/useTranslate'
import { colors } from '../theme/mobile-theme'
import type { ActionSheetAction } from './ActionSheetModal'
import { ActionSheetModal } from './ActionSheetModal'
import { BottomDrawer } from './BottomDrawer'
import { ConfirmModal } from './ConfirmModal'
import { mobileReviewCountLabel } from '../session/mobile-diff-review-screen-model'
import type { useMobileDiffReviewController } from '../session/use-mobile-diff-review-controller'
import { mobileDiffReviewStyles as styles } from './mobile-diff-review-screen-styles'

type Props = {
  controller: ReturnType<typeof useMobileDiffReviewController>
}

type TranslateFn = ReturnType<typeof useTranslate>['t']

export function MobileDiffReviewDrawers({ controller }: Props) {
  const { t } = useTranslate()
  const sendActions = useSendActions(controller, t)
  const overflowActions = useOverflowActions(controller, t)
  return (
    <>
      <ActionSheetModal
        visible={controller.showOverflow}
        title={t('mobile.diffReview.reviewActions', 'Review Actions')}
        message={
          controller.reviewedUnstagedCount > 0
            ? t(
                'mobile.diffReview.reviewedCanBeStaged',
                '{n} reviewed unstaged files can be staged',
                { n: controller.reviewedUnstagedCount }
              )
            : undefined
        }
        actions={overflowActions}
        onClose={() => controller.setShowOverflow(false)}
      />
      <ActionSheetModal
        visible={controller.sendSheet !== null}
        title={t('mobile.diffReview.sendNotes', 'Send Notes')}
        message={sendSheetMessage(controller, t)}
        actions={sendActions}
        onClose={() => controller.setSendSheet(null)}
      />
      <ConfirmModal
        visible={controller.discardTarget !== null}
        title={t('mobile.diffReview.discardFile', 'Discard File')}
        message={
          controller.discardTarget
            ? t(
                'mobile.diffReview.discardFileConfirm',
                'Discard changes to "{file}"? This cannot be undone.',
                { file: controller.discardTarget.filePath }
              )
            : undefined
        }
        confirmLabel={t('mobile.diffReview.discard', 'Discard')}
        destructive
        onConfirm={() => {
          const target = controller.discardTarget
          controller.setDiscardTarget(null)
          if (target) {
            void controller.runGitMutation('git.discard', target)
          }
        }}
        onCancel={() => controller.setDiscardTarget(null)}
      />
      <NoteComposerDrawer controller={controller} />
      <CompletionDrawer controller={controller} />
    </>
  )
}

function useSendActions(
  controller: ReturnType<typeof useMobileDiffReviewController>,
  t: TranslateFn
) {
  return useMemo<ActionSheetAction[]>(() => {
    const comments = controller.unsentComments
    const terminalActions =
      controller.sendSheet?.kind === 'ready' || controller.sendSheet?.kind === 'error'
        ? controller.sendSheet.terminals.map((terminal) => ({
            label: `${terminal.title || t('mobile.diffReview.terminalFallback', 'Terminal')} (${terminal.terminal.slice(0, 6)})`,
            icon: Send,
            disabled: comments.length === 0,
            skipAutoClose: true,
            onPress: () => void controller.sendPromptToTerminal(terminal.terminal, comments)
          }))
        : []
    return [
      ...terminalActions,
      {
        label: t('mobile.diffReview.newAgentSession', 'New Agent Session'),
        icon: Plus,
        disabled: comments.length === 0,
        skipAutoClose: true,
        onPress: () => void controller.createTerminalAndSend(comments)
      },
      {
        label: t('mobile.diffReview.copyNotes', 'Copy Notes'),
        icon: Copy,
        disabled:
          controller.screenState.kind !== 'ready' || controller.screenState.comments.length === 0,
        onPress: () => void controller.copyNotes()
      }
    ]
  }, [controller, t])
}

function useOverflowActions(
  controller: ReturnType<typeof useMobileDiffReviewController>,
  t: TranslateFn
) {
  return useMemo<ActionSheetAction[]>(
    () => [
      {
        label: t('mobile.diffReview.copyNotes', 'Copy Notes'),
        icon: Copy,
        disabled:
          controller.screenState.kind !== 'ready' || controller.screenState.comments.length === 0,
        onPress: () => void controller.copyNotes()
      },
      {
        label: t('mobile.diffReview.sendUnsentNotes', 'Send Unsent Notes'),
        icon: Send,
        disabled: controller.unsentComments.length === 0,
        skipAutoClose: true,
        onPress: () => controller.openSendSheet()
      },
      {
        label: t('mobile.diffReview.clearSentNotes', 'Clear Sent Notes'),
        icon: Trash2,
        disabled:
          controller.screenState.kind !== 'ready' ||
          controller.screenState.comments.every((comment) => comment.sentAt === undefined),
        skipAutoClose: true,
        onPress: () => controller.clearSentNotes()
      },
      {
        label: t('mobile.diffReview.stageReviewedFiles', 'Stage Reviewed Files'),
        icon: Check,
        disabled: controller.reviewedUnstagedCount === 0 || controller.busyAction !== null,
        skipAutoClose: true,
        onPress: () => controller.stageReviewedFiles()
      },
      {
        label: t('mobile.diffReview.markUnreviewed', 'Mark Unreviewed'),
        icon: X,
        disabled:
          controller.screenState.kind !== 'ready' ||
          !controller.currentItem ||
          !controller.currentItem.isReviewed,
        skipAutoClose: true,
        onPress: () => controller.markUnreviewed()
      },
      {
        label: t('mobile.diffReview.openInSession', 'Open in Session'),
        icon: FileText,
        disabled: !controller.currentItem || controller.currentItem.scope === 'branch',
        onPress: () => controller.openInSession()
      }
    ],
    [controller, t]
  )
}

function sendSheetMessage(
  controller: ReturnType<typeof useMobileDiffReviewController>,
  t: TranslateFn
): string | undefined {
  return controller.sendSheet?.kind === 'loading'
    ? t('mobile.diffReview.loadingSessions', 'Loading agent sessions...')
    : controller.sendSheet?.kind === 'error'
      ? controller.sendSheet.message
      : t('mobile.diffReview.unsentNotes', '{n} unsent notes', {
          n: controller.unsentComments.length
        })
}

function NoteComposerDrawer({ controller }: Props) {
  const { t } = useTranslate()
  const composer = controller.composer
  return (
    <BottomDrawer visible={composer !== null} onClose={controller.closeComposer}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.composerHeader}>
          <View>
            <Text style={styles.drawerTitle}>
              {composer?.mode === 'edit'
                ? t('mobile.diffReview.editNote', 'Edit Note')
                : t('mobile.diffReview.addNote', 'Add Note')}
            </Text>
            <Text style={styles.drawerSubtitle}>
              {composer?.mode === 'create' && composer.lineNumber > 0
                ? t('mobile.diffReview.lineN', 'Line {n}', { n: composer.lineNumber })
                : t('mobile.diffReview.fileNote', 'File note')}
            </Text>
          </View>
          <Pressable
            style={({ pressed }) => [styles.iconButton, pressed && styles.iconButtonPressed]}
            onPress={controller.closeComposer}
            accessibilityRole="button"
            accessibilityLabel={t('mobile.diffReview.cancelNote', 'Cancel note')}
          >
            <X size={18} color={colors.textPrimary} strokeWidth={2.2} />
          </Pressable>
        </View>
        <TextInput
          style={styles.composerInput}
          value={controller.composerBody}
          onChangeText={controller.setComposerBody}
          multiline
          autoFocus
          placeholder={t('mobile.diffReview.reviewNote', 'Review note')}
          placeholderTextColor={colors.textMuted}
          accessibilityLabel={composerLabel(composer, t)}
        />
        <View style={styles.drawerButtonRow}>
          {composer?.mode === 'edit' ? (
            <DeleteNoteButton onPress={controller.deleteComment} />
          ) : null}
          <SaveNoteButton controller={controller} composer={composer} />
        </View>
      </KeyboardAvoidingView>
    </BottomDrawer>
  )
}

function composerLabel(
  composer: { mode: 'create'; lineNumber: number } | { mode: 'edit'; comment: DiffComment } | null,
  t: TranslateFn
): string {
  return composer?.mode === 'create' && composer.lineNumber > 0
    ? t('mobile.diffReview.saveNoteOnLine', 'Save note on line {n}', { n: composer.lineNumber })
    : t('mobile.diffReview.reviewNote', 'Review note')
}

function DeleteNoteButton({ onPress }: { onPress: () => Promise<void> }) {
  const { t } = useTranslate()
  return (
    <Pressable
      style={({ pressed }) => [styles.secondaryButton, pressed && styles.buttonPressed]}
      onPress={() => void onPress()}
      accessibilityRole="button"
      accessibilityLabel={t('mobile.diffReview.deleteNote', 'Delete note')}
    >
      <Trash2 size={14} color={colors.statusRed} strokeWidth={2.2} />
      <Text style={styles.destructiveText}>{t('mobile.diffReview.delete', 'Delete')}</Text>
    </Pressable>
  )
}

function SaveNoteButton({
  controller,
  composer
}: {
  controller: ReturnType<typeof useMobileDiffReviewController>
  composer: ReturnType<typeof useMobileDiffReviewController>['composer']
}) {
  const { t } = useTranslate()
  const disabled = controller.composerBody.trim().length === 0
  return (
    <Pressable
      style={({ pressed }) => [
        styles.primaryButton,
        disabled && styles.buttonDisabled,
        pressed && styles.buttonPressed
      ]}
      disabled={disabled}
      onPress={() => void controller.saveComposer()}
      accessibilityRole="button"
      accessibilityLabel={composerLabel(composer, t)}
    >
      <Check size={14} color={colors.bgBase} strokeWidth={2.2} />
      <Text style={styles.primaryButtonText}>{t('mobile.diffReview.save', 'Save')}</Text>
    </Pressable>
  )
}

function CompletionDrawer({ controller }: Props) {
  const { t } = useTranslate()
  const noteCount =
    controller.screenState.kind === 'ready' ? controller.screenState.comments.length : 0
  return (
    <BottomDrawer
      visible={controller.showCompletion}
      onClose={() => controller.setShowCompletion(false)}
    >
      <Text style={styles.drawerTitle}>
        {t('mobile.diffReview.reviewComplete', 'Review Complete')}
      </Text>
      <Text style={styles.drawerSubtitle}>
        {mobileReviewCountLabel(controller.queue.length, 'file', 'files')} reviewed,{' '}
        {mobileReviewCountLabel(noteCount, 'note', 'notes')}
      </Text>
      <View style={styles.drawerButtonRow}>
        <Pressable
          style={({ pressed }) => [styles.secondaryButton, pressed && styles.buttonPressed]}
          disabled={controller.reviewedUnstagedCount === 0}
          onPress={() => void controller.stageReviewedFiles()}
          accessibilityRole="button"
          accessibilityLabel={t('mobile.diffReview.stageReviewedFilesA11y', 'Stage reviewed files')}
        >
          <Check size={14} color={colors.textSecondary} strokeWidth={2.2} />
          <Text style={styles.secondaryButtonText}>
            {t('mobile.diffReview.stageReviewed', 'Stage Reviewed')}
          </Text>
        </Pressable>
        <Pressable
          style={({ pressed }) => [styles.primaryButton, pressed && styles.buttonPressed]}
          disabled={controller.unsentComments.length === 0}
          onPress={() => void controller.openSendSheet()}
          accessibilityRole="button"
          accessibilityLabel={t('mobile.diffReview.sendNotesToAgent', 'Send notes to agent')}
        >
          <Send size={14} color={colors.bgBase} strokeWidth={2.2} />
          <Text style={styles.primaryButtonText}>
            {t('mobile.diffReview.sendNotes', 'Send Notes')}
          </Text>
        </Pressable>
      </View>
    </BottomDrawer>
  )
}
