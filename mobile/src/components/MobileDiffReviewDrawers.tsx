import { useMemo } from 'react'
import { KeyboardAvoidingView, Platform, Pressable, Text, TextInput, View } from 'react-native'
import { Check, Copy, FileText, Plus, Send, Trash2, X } from 'lucide-react-native'
import type { DiffComment } from '../../../src/shared/diff-comment-types'
import { useKeyboardAvoidingPadding } from '../platform/keyboard-occlusion'
import { colors } from '../theme/mobile-theme'
import type { ActionSheetAction } from './ActionSheetModal'
import { ActionSheetContent } from './ActionSheetModal'
import { ConfirmContent } from './ConfirmModal'
import { KeyedBottomDrawer } from './keyed-bottom-drawer'
import {
  mobileReviewCountLabel,
  type ComposerState,
  type SendSheetState
} from '../session/mobile-diff-review-screen-model'
import { reviewSheetKey, type ReviewSheet } from '../session/mobile-diff-review-sheets'
import type { useMobileDiffReviewController } from '../session/use-mobile-diff-review-controller'
import { mobileDiffReviewStyles as styles } from './mobile-diff-review-screen-styles'

type Props = {
  controller: ReturnType<typeof useMobileDiffReviewController>
}

export function MobileDiffReviewDrawers({ controller }: Props) {
  // One drawer for every review sheet: iOS cannot present a sheet while another is still closing.
  return (
    <KeyedBottomDrawer
      sheet={controller.sheet}
      sheetKey={reviewSheetKey}
      onClose={(presented) => controller.closeSheet(presented.kind)}
    >
      {(presented) => <ReviewSheetContent controller={controller} sheet={presented} />}
    </KeyedBottomDrawer>
  )
}

function ReviewSheetContent({ controller, sheet }: Props & { sheet: ReviewSheet }) {
  switch (sheet.kind) {
    case 'actions':
      return <ReviewActionsContent controller={controller} />
    case 'send':
      return <SendNotesContent controller={controller} load={sheet.load} />
    case 'discard':
      return (
        <ConfirmContent
          title="Discard File"
          message={`Discard changes to "${sheet.target.filePath}"? This cannot be undone.`}
          confirmLabel="Discard"
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
  }
}

function ReviewActionsContent({ controller }: Props) {
  const overflowActions = useOverflowActions(controller)
  return (
    <ActionSheetContent
      title="Review Actions"
      message={
        controller.reviewedUnstagedCount > 0
          ? `${controller.reviewedUnstagedCount} reviewed unstaged files can be staged`
          : undefined
      }
      actions={overflowActions}
      onClose={() => controller.closeSheet('actions')}
    />
  )
}

function SendNotesContent({ controller, load }: Props & { load: SendSheetState }) {
  const sendActions = useSendActions(controller, load)
  return (
    <ActionSheetContent
      title="Send Notes"
      message={sendSheetMessage(controller, load)}
      actions={sendActions}
      onClose={() => controller.closeSheet('send')}
    />
  )
}

function useSendActions(
  controller: ReturnType<typeof useMobileDiffReviewController>,
  load: SendSheetState
) {
  return useMemo<ActionSheetAction[]>(() => {
    const comments = controller.unsentComments
    const terminalActions =
      load.kind === 'ready' || load.kind === 'error'
        ? load.terminals.map((terminal) => ({
            label: `${terminal.title || 'Terminal'} (${terminal.terminal.slice(0, 6)})`,
            icon: Send,
            disabled: comments.length === 0,
            skipAutoClose: true,
            onPress: () => void controller.sendPromptToTerminal(terminal.terminal, comments)
          }))
        : []
    return [
      ...terminalActions,
      {
        label: 'New Agent Session',
        icon: Plus,
        disabled: comments.length === 0,
        skipAutoClose: true,
        onPress: () => void controller.createTerminalAndSend(comments)
      },
      {
        label: 'Copy Notes',
        icon: Copy,
        disabled:
          controller.screenState.kind !== 'ready' || controller.screenState.comments.length === 0,
        onPress: () => void controller.copyNotes()
      }
    ]
  }, [controller, load])
}

function useOverflowActions(controller: ReturnType<typeof useMobileDiffReviewController>) {
  return useMemo<ActionSheetAction[]>(
    () => [
      {
        label: 'Copy Notes',
        icon: Copy,
        disabled:
          controller.screenState.kind !== 'ready' || controller.screenState.comments.length === 0,
        onPress: () => void controller.copyNotes()
      },
      {
        label: 'Send Unsent Notes',
        icon: Send,
        disabled: controller.unsentComments.length === 0,
        onPress: () => void controller.openSendSheet()
      },
      {
        label: 'Clear Sent Notes',
        icon: Trash2,
        disabled:
          controller.screenState.kind !== 'ready' ||
          controller.screenState.comments.every((comment) => comment.sentAt === undefined),
        skipAutoClose: true,
        onPress: () => void controller.clearSentNotes()
      },
      {
        label: 'Stage Reviewed Files',
        icon: Check,
        disabled: controller.reviewedUnstagedCount === 0 || controller.busyAction !== null,
        skipAutoClose: true,
        onPress: () => void controller.stageReviewedFiles()
      },
      {
        label: 'Mark Unreviewed',
        icon: X,
        disabled:
          controller.screenState.kind !== 'ready' ||
          !controller.currentItem ||
          !controller.currentItem.isReviewed,
        skipAutoClose: true,
        onPress: () => void controller.markUnreviewed()
      },
      {
        label: 'Open in Session',
        icon: FileText,
        disabled: !controller.currentItem || controller.currentItem.scope === 'branch',
        onPress: () => void controller.openInSession()
      }
    ],
    [controller]
  )
}

function sendSheetMessage(
  controller: ReturnType<typeof useMobileDiffReviewController>,
  load: SendSheetState
): string | undefined {
  return load.kind === 'loading'
    ? 'Loading agent sessions...'
    : load.kind === 'error'
      ? load.message
      : `${controller.unsentComments.length} unsent notes`
}

function NoteComposerContent({ controller, composer }: Props & { composer: ComposerState }) {
  // Zero on a phone, where `KeyboardAvoidingView` above already moved this; the page's own
  // keyboard measurement where it cannot, because that view is driven by events RN Web never
  // sends. Padding rather than a second avoiding view: the drawer owns the position.
  const keyboardPadding = useKeyboardAvoidingPadding()
  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={keyboardPadding > 0 ? { paddingBottom: keyboardPadding } : undefined}
    >
      <View style={styles.composerHeader}>
        <View>
          <Text style={styles.drawerTitle}>
            {composer.mode === 'edit' ? 'Edit Note' : 'Add Note'}
          </Text>
          <Text style={styles.drawerSubtitle}>
            {composer.mode === 'create' && composer.lineNumber > 0
              ? `Line ${composer.lineNumber}`
              : 'File note'}
          </Text>
        </View>
        <Pressable
          style={({ pressed }) => [styles.iconButton, pressed && styles.iconButtonPressed]}
          onPress={controller.closeComposer}
          accessibilityRole="button"
          accessibilityLabel="Cancel note"
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
        placeholder="Review note"
        placeholderTextColor={colors.textMuted}
        accessibilityLabel={composerLabel(composer)}
      />
      <View style={styles.drawerButtonRow}>
        {composer.mode === 'edit' ? <DeleteNoteButton onPress={controller.deleteComment} /> : null}
        <SaveNoteButton controller={controller} composer={composer} />
      </View>
    </KeyboardAvoidingView>
  )
}

function composerLabel(
  composer: { mode: 'create'; lineNumber: number } | { mode: 'edit'; comment: DiffComment } | null
): string {
  return composer?.mode === 'create' && composer.lineNumber > 0
    ? `Save note on line ${composer.lineNumber}`
    : 'Review note'
}

function DeleteNoteButton({ onPress }: { onPress: () => Promise<void> }) {
  return (
    <Pressable
      style={({ pressed }) => [styles.secondaryButton, pressed && styles.buttonPressed]}
      onPress={() => void onPress()}
      accessibilityRole="button"
      accessibilityLabel="Delete note"
    >
      <Trash2 size={14} color={colors.statusRed} strokeWidth={2.2} />
      <Text style={styles.destructiveText}>Delete</Text>
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
      <Text style={styles.primaryButtonText}>Save</Text>
    </Pressable>
  )
}

function CompletionContent({ controller }: Props) {
  const noteCount =
    controller.screenState.kind === 'ready' ? controller.screenState.comments.length : 0
  return (
    <>
      <Text style={styles.drawerTitle}>Review Complete</Text>
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
          accessibilityLabel="Stage reviewed files"
        >
          <Check size={14} color={colors.textSecondary} strokeWidth={2.2} />
          <Text style={styles.secondaryButtonText}>Stage Reviewed</Text>
        </Pressable>
        <Pressable
          style={({ pressed }) => [styles.primaryButton, pressed && styles.buttonPressed]}
          disabled={controller.unsentComments.length === 0}
          onPress={() => void controller.openSendSheet()}
          accessibilityRole="button"
          accessibilityLabel="Send notes to agent"
        >
          <Send size={14} color={colors.bgBase} strokeWidth={2.2} />
          <Text style={styles.primaryButtonText}>Send Notes</Text>
        </Pressable>
      </View>
    </>
  )
}
