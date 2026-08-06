import { useMemo } from 'react'
import { KeyboardAvoidingView, Platform, Pressable, Text, TextInput, View } from 'react-native'
import { Check, Copy, FileText, Plus, Send, Trash2, X } from 'lucide-react-native'
import type { DiffComment } from '../../../src/shared/types'
import { colors } from '../theme/mobile-theme'
import type { ActionSheetAction } from './ActionSheetModal'
import { ActionSheetModal } from './ActionSheetModal'
import { BottomDrawer } from './BottomDrawer'
import { ConfirmModal } from './ConfirmModal'
import type { useMobileDiffReviewController } from '../session/use-mobile-diff-review-controller'
import { mobileDiffReviewStyles as styles } from './mobile-diff-review-screen-styles'
import { t } from '@/i18n/mobile-i18n'

type Props = {
  controller: ReturnType<typeof useMobileDiffReviewController>
}

export function MobileDiffReviewDrawers({ controller }: Props) {
  const sendActions = useSendActions(controller)
  const overflowActions = useOverflowActions(controller)
  return (
    <>
      <ActionSheetModal
        visible={controller.showOverflow}
        title={t('mobileDiffReviewDrawers.reviewActions')}
        message={
          controller.reviewedUnstagedCount > 0
            ? t('mobileDiffReviewDrawers.reviewedFileCountReviewed', {
                reviewedFileCount: controller.reviewedUnstagedCount
              })
            : undefined
        }
        actions={overflowActions}
        onClose={() => controller.setShowOverflow(false)}
      />
      <ActionSheetModal
        visible={controller.sendSheet !== null}
        title={t('mobileDiffReviewDrawers.sendNotes')}
        message={sendSheetMessage(controller)}
        actions={sendActions}
        onClose={() => controller.setSendSheet(null)}
      />
      <ConfirmModal
        visible={controller.discardTarget !== null}
        title={t('mobileDiffReviewDrawers.discardFile')}
        message={
          controller.discardTarget
            ? t('mobileDiffReviewDrawers.discardChanges', {
                filePath: controller.discardTarget.filePath
              })
            : undefined
        }
        confirmLabel={t('mobileDiffReviewDrawers.discard')}
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

function useSendActions(controller: ReturnType<typeof useMobileDiffReviewController>) {
  return useMemo<ActionSheetAction[]>(() => {
    const comments = controller.unsentComments
    const terminalActions =
      controller.sendSheet?.kind === 'ready' || controller.sendSheet?.kind === 'error'
        ? controller.sendSheet.terminals.map((terminal) => ({
            label: `${terminal.title || t('mobileDiffReviewDrawers.terminal')} (${terminal.terminal.slice(0, 6)})`,
            icon: Send,
            disabled: comments.length === 0,
            skipAutoClose: true,
            onPress: () => void controller.sendPromptToTerminal(terminal.terminal, comments)
          }))
        : []
    return [
      ...terminalActions,
      {
        label: t('mobileDiffReviewDrawers.new'),
        icon: Plus,
        disabled: comments.length === 0,
        skipAutoClose: true,
        onPress: () => void controller.createTerminalAndSend(comments)
      },
      {
        label: t('mobileDiffReviewDrawers.copy'),
        icon: Copy,
        disabled:
          controller.screenState.kind !== 'ready' || controller.screenState.comments.length === 0,
        onPress: () => void controller.copyNotes()
      }
    ]
  }, [controller])
}

function useOverflowActions(controller: ReturnType<typeof useMobileDiffReviewController>) {
  return useMemo<ActionSheetAction[]>(
    () => [
      {
        label: t('mobileDiffReviewDrawers.copy'),
        icon: Copy,
        disabled:
          controller.screenState.kind !== 'ready' || controller.screenState.comments.length === 0,
        onPress: () => void controller.copyNotes()
      },
      {
        label: t('mobileDiffReviewDrawers.sendUnsent'),
        icon: Send,
        disabled: controller.unsentComments.length === 0,
        skipAutoClose: true,
        onPress: () => void controller.openSendSheet()
      },
      {
        label: t('mobileDiffReviewDrawers.clear'),
        icon: Trash2,
        disabled:
          controller.screenState.kind !== 'ready' ||
          controller.screenState.comments.every((comment) => comment.sentAt === undefined),
        skipAutoClose: true,
        onPress: () => void controller.clearSentNotes()
      },
      {
        label: t('mobileDiffReviewDrawers.stageReviewedFiles'),
        icon: Check,
        disabled: controller.reviewedUnstagedCount === 0 || controller.busyAction !== null,
        skipAutoClose: true,
        onPress: () => void controller.stageReviewedFiles()
      },
      {
        label: t('mobileDiffReviewDrawers.mark'),
        icon: X,
        disabled:
          controller.screenState.kind !== 'ready' ||
          !controller.currentItem ||
          !controller.currentItem.isReviewed,
        skipAutoClose: true,
        onPress: () => void controller.markUnreviewed()
      },
      {
        label: t('mobileDiffReviewDrawers.open'),
        icon: FileText,
        disabled: !controller.currentItem || controller.currentItem.scope === 'branch',
        onPress: () => void controller.openInSession()
      }
    ],
    [controller]
  )
}

function sendSheetMessage(
  controller: ReturnType<typeof useMobileDiffReviewController>
): string | undefined {
  return controller.sendSheet?.kind === 'loading'
    ? t('mobileDiffReviewDrawers.loading')
    : controller.sendSheet?.kind === 'error'
      ? controller.sendSheet.message
      : t('mobileDiffReviewDrawers.unsent', {
          unsentCommentCount: controller.unsentComments.length
        })
}

function NoteComposerDrawer({ controller }: Props) {
  const composer = controller.composer
  return (
    <BottomDrawer visible={composer !== null} onClose={controller.closeComposer}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.composerHeader}>
          <View>
            <Text style={styles.drawerTitle}>
              {composer?.mode === 'edit'
                ? t('mobileDiffReviewDrawers.edit')
                : t('mobileDiffReviewDrawers.add')}
            </Text>
            <Text style={styles.drawerSubtitle}>
              {composer?.mode === 'create' && composer.lineNumber > 0
                ? t('mobileDiffReviewDrawers.line', {
                    lineNumber: composer.lineNumber
                  })
                : t('mobileDiffReviewDrawers.file')}
            </Text>
          </View>
          <Pressable
            style={({ pressed }) => [styles.iconButton, pressed && styles.iconButtonPressed]}
            onPress={controller.closeComposer}
            accessibilityRole="button"
            accessibilityLabel={t('mobileDiffReviewDrawers.cancel')}
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
          placeholder={t('mobileDiffReviewDrawers.reviewNote')}
          placeholderTextColor={colors.textMuted}
          accessibilityLabel={composerLabel(composer)}
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
  composer: { mode: 'create'; lineNumber: number } | { mode: 'edit'; comment: DiffComment } | null
): string {
  return composer?.mode === 'create' && composer.lineNumber > 0
    ? t('mobileDiffReviewDrawers.saveNote', {
        lineNumber: composer.lineNumber
      })
    : t('mobileDiffReviewDrawers.reviewNote')
}

function DeleteNoteButton({ onPress }: { onPress: () => Promise<void> }) {
  return (
    <Pressable
      style={({ pressed }) => [styles.secondaryButton, pressed && styles.buttonPressed]}
      onPress={() => void onPress()}
      accessibilityRole="button"
      accessibilityLabel={t('mobileDiffReviewDrawers.deleteNote')}
    >
      <Trash2 size={14} color={colors.statusRed} strokeWidth={2.2} />
      <Text style={styles.destructiveText}>{t('mobileDiffReviewDrawers.delete')}</Text>
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
      accessibilityLabel={composerLabel(composer)}
    >
      <Check size={14} color={colors.bgBase} strokeWidth={2.2} />
      <Text style={styles.primaryButtonText}>{t('mobileDiffReviewDrawers.save')}</Text>
    </Pressable>
  )
}

function CompletionDrawer({ controller }: Props) {
  const noteCount =
    controller.screenState.kind === 'ready' ? controller.screenState.comments.length : 0
  return (
    <BottomDrawer
      visible={controller.showCompletion}
      onClose={() => controller.setShowCompletion(false)}
    >
      <Text style={styles.drawerTitle}>{t('mobileDiffReviewDrawers.reviewComplete')}</Text>
      <Text style={styles.drawerSubtitle}>
        {t(
          controller.queue.length === 1
            ? noteCount === 1
              ? 'mobileDiffReviewDrawers.reviewedFileCountFileReviewedNoteCountNote'
              : 'mobileDiffReviewDrawers.reviewedFileCountFileReviewedNoteCountNotes'
            : noteCount === 1
              ? 'mobileDiffReviewDrawers.reviewedFileCountFilesReviewedNoteCountNote'
              : 'mobileDiffReviewDrawers.reviewedFileCountFilesReviewedNoteCountNotes',
          { reviewedFileCount: controller.queue.length, noteCount: noteCount }
        )}
      </Text>
      <View style={styles.drawerButtonRow}>
        <Pressable
          style={({ pressed }) => [styles.secondaryButton, pressed && styles.buttonPressed]}
          disabled={controller.reviewedUnstagedCount === 0}
          onPress={() => void controller.stageReviewedFiles()}
          accessibilityRole="button"
          accessibilityLabel={t('mobileDiffReviewDrawers.stageReviewedFilesAccessibility')}
        >
          <Check size={14} color={colors.textSecondary} strokeWidth={2.2} />
          <Text style={styles.secondaryButtonText}>
            {t('mobileDiffReviewDrawers.stageReviewed')}
          </Text>
        </Pressable>
        <Pressable
          style={({ pressed }) => [styles.primaryButton, pressed && styles.buttonPressed]}
          disabled={controller.unsentComments.length === 0}
          onPress={() => void controller.openSendSheet()}
          accessibilityRole="button"
          accessibilityLabel={t('mobileDiffReviewDrawers.sendNotesAgent')}
        >
          <Send size={14} color={colors.bgBase} strokeWidth={2.2} />
          <Text style={styles.primaryButtonText}>{t('mobileDiffReviewDrawers.sendNotes')}</Text>
        </Pressable>
      </View>
    </BottomDrawer>
  )
}
