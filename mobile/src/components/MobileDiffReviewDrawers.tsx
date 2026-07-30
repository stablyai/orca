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
        title={t('m.oCVOA0w')}
        message={
          controller.reviewedUnstagedCount > 0
            ? t('m._TCuNKQ', { value0: controller.reviewedUnstagedCount })
            : undefined
        }
        actions={overflowActions}
        onClose={() => controller.setShowOverflow(false)}
      />
      <ActionSheetModal
        visible={controller.sendSheet !== null}
        title={t('m.voLBMwU')}
        message={sendSheetMessage(controller)}
        actions={sendActions}
        onClose={() => controller.setSendSheet(null)}
      />
      <ConfirmModal
        visible={controller.discardTarget !== null}
        title={t('m.1V8B5pc')}
        message={
          controller.discardTarget
            ? t('m.ajcWpiI', { value0: controller.discardTarget.filePath })
            : undefined
        }
        confirmLabel={t('m.-YeAYjI')}
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
            label: `${terminal.title || t('m.4GOORsg')} (${terminal.terminal.slice(0, 6)})`,
            icon: Send,
            disabled: comments.length === 0,
            skipAutoClose: true,
            onPress: () => void controller.sendPromptToTerminal(terminal.terminal, comments)
          }))
        : []
    return [
      ...terminalActions,
      {
        label: t('m.qljZwNc'),
        icon: Plus,
        disabled: comments.length === 0,
        skipAutoClose: true,
        onPress: () => void controller.createTerminalAndSend(comments)
      },
      {
        label: t('m.SGgu3t8'),
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
        label: t('m.SGgu3t8'),
        icon: Copy,
        disabled:
          controller.screenState.kind !== 'ready' || controller.screenState.comments.length === 0,
        onPress: () => void controller.copyNotes()
      },
      {
        label: t('m.bboDcz4'),
        icon: Send,
        disabled: controller.unsentComments.length === 0,
        skipAutoClose: true,
        onPress: () => void controller.openSendSheet()
      },
      {
        label: t('m.AMn9p6c'),
        icon: Trash2,
        disabled:
          controller.screenState.kind !== 'ready' ||
          controller.screenState.comments.every((comment) => comment.sentAt === undefined),
        skipAutoClose: true,
        onPress: () => void controller.clearSentNotes()
      },
      {
        label: t('m.9YSL2XY'),
        icon: Check,
        disabled: controller.reviewedUnstagedCount === 0 || controller.busyAction !== null,
        skipAutoClose: true,
        onPress: () => void controller.stageReviewedFiles()
      },
      {
        label: t('m.lDOi4xI'),
        icon: X,
        disabled:
          controller.screenState.kind !== 'ready' ||
          !controller.currentItem ||
          !controller.currentItem.isReviewed,
        skipAutoClose: true,
        onPress: () => void controller.markUnreviewed()
      },
      {
        label: t('m.QyPs23A'),
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
    ? t('m.ycKwNOI')
    : controller.sendSheet?.kind === 'error'
      ? controller.sendSheet.message
      : t('m.5Rc0T-w', { value0: controller.unsentComments.length })
}

function NoteComposerDrawer({ controller }: Props) {
  const composer = controller.composer
  return (
    <BottomDrawer visible={composer !== null} onClose={controller.closeComposer}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.composerHeader}>
          <View>
            <Text style={styles.drawerTitle}>
              {composer?.mode === 'edit' ? t('m.vX8hCPw') : t('m.SqSZ_D4')}
            </Text>
            <Text style={styles.drawerSubtitle}>
              {composer?.mode === 'create' && composer.lineNumber > 0
                ? t('m.YlMekyY', { value0: composer.lineNumber })
                : t('m.K4ExXj0')}
            </Text>
          </View>
          <Pressable
            style={({ pressed }) => [styles.iconButton, pressed && styles.iconButtonPressed]}
            onPress={controller.closeComposer}
            accessibilityRole="button"
            accessibilityLabel={t('m.cy6hF-c')}
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
          placeholder={t('m.2lwuEDc')}
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
    ? t('m.972Qfrg', { value0: composer.lineNumber })
    : t('m.2lwuEDc')
}

function DeleteNoteButton({ onPress }: { onPress: () => Promise<void> }) {
  return (
    <Pressable
      style={({ pressed }) => [styles.secondaryButton, pressed && styles.buttonPressed]}
      onPress={() => void onPress()}
      accessibilityRole="button"
      accessibilityLabel={t('m.7BEb-8o')}
    >
      <Trash2 size={14} color={colors.statusRed} strokeWidth={2.2} />
      <Text style={styles.destructiveText}>{t('m.-bToH9I')}</Text>
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
      <Text style={styles.primaryButtonText}>{t('m.ls_e0g8')}</Text>
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
      <Text style={styles.drawerTitle}>{t('m.du7kB18')}</Text>
      <Text style={styles.drawerSubtitle}>
        {t(
          controller.queue.length === 1
            ? noteCount === 1
              ? 'm.QlrZNys'
              : 'm.J7M3gnY'
            : noteCount === 1
              ? 'm.uM2_gxc'
              : 'm.JrNt3Dk',
          { value0: controller.queue.length, value1: noteCount }
        )}
      </Text>
      <View style={styles.drawerButtonRow}>
        <Pressable
          style={({ pressed }) => [styles.secondaryButton, pressed && styles.buttonPressed]}
          disabled={controller.reviewedUnstagedCount === 0}
          onPress={() => void controller.stageReviewedFiles()}
          accessibilityRole="button"
          accessibilityLabel={t('m.XhmaYgY')}
        >
          <Check size={14} color={colors.textSecondary} strokeWidth={2.2} />
          <Text style={styles.secondaryButtonText}>{t('m.a1hiCFE')}</Text>
        </Pressable>
        <Pressable
          style={({ pressed }) => [styles.primaryButton, pressed && styles.buttonPressed]}
          disabled={controller.unsentComments.length === 0}
          onPress={() => void controller.openSendSheet()}
          accessibilityRole="button"
          accessibilityLabel={t('m.XNffV5A')}
        >
          <Send size={14} color={colors.bgBase} strokeWidth={2.2} />
          <Text style={styles.primaryButtonText}>{t('m.voLBMwU')}</Text>
        </Pressable>
      </View>
    </BottomDrawer>
  )
}
